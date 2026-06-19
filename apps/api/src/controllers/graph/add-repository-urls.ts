import { ulid } from "ulid";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { serializeCodeFileMetadata } from "@kiwi/graph/code/metadata";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import type { GraphAddUrlFields } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError, makeApiError, noChangesError } from "@kiwi/contracts/errors";
import { env } from "../../env";
import {
    buildGitHubExternalCodeFile,
    loadRepositoryFromUrl,
    MAX_REPOSITORY_URLS,
    RepositoryUrlError,
    type LoadedRepository,
} from "../../lib/repository-url";
import { assertCanManageGraphFiles } from "../../lib/graph/access";
import {
    assertConfiguredUploadModels,
    cleanupUploadedKeys,
    commitGraphFileUploads,
    restoreGraphFileChangeFailure,
    type UploadedFile,
} from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { toApiError } from "../_shared/api-effect";
import { getGraphOwnerModelOrganizationId } from "./upload-helpers";

type RepositoryUploadSource = {
    repository: LoadedRepository;
    file: LoadedRepository["files"][number];
    checksum: string;
};

class ContentChecksumError extends Schema.TaggedErrorClass<ContentChecksumError>()("ContentChecksumError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
}) {}

class ProcessRunCreationError extends Schema.TaggedErrorClass<ProcessRunCreationError>()("ProcessRunCreationError", {
    message: Schema.String,
}) {}

class ProcessFilesWorkflowEnqueueError extends Schema.TaggedErrorClass<ProcessFilesWorkflowEnqueueError>()(
    "ProcessFilesWorkflowEnqueueError",
    {
        message: Schema.String,
        cause: Schema.optional(Schema.Unknown),
    }
) {}

function contentChecksum(content: string): Effect.Effect<string, unknown> {
    return Effect.map(
        Effect.tryPromise({
            try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
            catch: (cause) =>
                new ContentChecksumError({
                    message: "Failed to compute repository file checksum",
                    cause,
                }),
        }),
        (hashBuffer) => [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    );
}

function repositoryUrlError(error: unknown) {
    const repositoryError =
        error instanceof RepositoryUrlError
            ? error
            : error instanceof Error && error.cause instanceof RepositoryUrlError
              ? error.cause
              : undefined;

    if (!repositoryError) {
        return makeApiError(400, API_ERROR_CODES.UNSUPPORTED_FILE_TYPE, "Repository could not be loaded");
    }

    if (repositoryError.kind === "limit") {
        return makeApiError(413, API_ERROR_CODES.UPLOAD_LIMIT_EXCEEDED, repositoryError.message);
    }

    return makeApiError(
        400,
        API_ERROR_CODES.UNSUPPORTED_FILE_TYPE,
        repositoryError.kind === "validation" ? repositoryError.message : "Repository could not be loaded"
    );
}

export const addGraphRepositoryUrls = Effect.fn("addGraphRepositoryUrls")(
    (input: { user: AuthUser; graphId: string; body: GraphAddUrlFields }) =>
        Effect.mapError(
            Effect.gen(function* () {
                const existingGraph = yield* assertCanManageGraphFiles(input.user, input.graphId);
                const urls = [...new Set(input.body.urls.map((url) => url.trim()).filter(Boolean))];
                if (urls.length === 0) {
                    return yield* Effect.fail(noChangesError());
                }
                if (urls.length > MAX_REPOSITORY_URLS) {
                    return yield* Effect.fail(
                        makeApiError(
                            413,
                            API_ERROR_CODES.UPLOAD_LIMIT_EXCEEDED,
                            `At most ${MAX_REPOSITORY_URLS} repository URLs can be processed at once`
                        )
                    );
                }

                const repositories: LoadedRepository[] = [];
                for (const url of urls) {
                    repositories.push(yield* Effect.mapError(loadRepositoryFromUrl(url), repositoryUrlError));
                }

                const seenSnapshotFiles = new Set<string>();
                const repositorySources: RepositoryUploadSource[] = [];
                for (const repository of repositories) {
                    for (const file of repository.files) {
                        const checksum = yield* contentChecksum(file.content);
                        const snapshotFileKey = `${repository.url}:${checksum}`;
                        if (seenSnapshotFiles.has(snapshotFileKey)) {
                            continue;
                        }

                        seenSnapshotFiles.add(snapshotFileKey);
                        repositorySources.push({ repository, file, checksum });
                    }
                }

                if (repositorySources.length === 0) {
                    return { graph: existingGraph, addedFiles: [], workflowRunId: null };
                }

                const organizationId = yield* getGraphOwnerModelOrganizationId({
                    ownerMode: "graph",
                    graphId: existingGraph.id,
                });
                yield* assertConfiguredUploadModels({
                    organizationId,
                    files: repositorySources.map(() => ({ type: "code" as const })),
                    secret: env.AUTH_SECRET,
                });

                const uploadedFiles: UploadedFile[] = [];
                yield* Effect.matchEffect(
                    Effect.gen(function* () {
                        for (const source of repositorySources) {
                            const fileId = ulid();
                            const name = `${source.repository.name}/${source.file.path}`;
                            const external = buildGitHubExternalCodeFile({
                                repositoryUrl: source.repository.url,
                                commitSha: source.repository.commitSha,
                                path: source.file.path,
                            });

                            if (external) {
                                uploadedFiles.push({
                                    id: fileId,
                                    name,
                                    size: source.file.size,
                                    type: "code",
                                    mimeType: "text/plain",
                                    key: external.key,
                                    storageKind: "external",
                                    externalProvider: external.provider,
                                    externalUrl: external.rawUrl,
                                    checksum: source.checksum,
                                    metadata: serializeCodeFileMetadata({
                                        repositoryUrl: source.repository.url,
                                        repositoryName: source.repository.name,
                                        commitSha: source.repository.commitSha,
                                        path: source.file.path,
                                        external: {
                                            provider: external.provider,
                                            rawUrl: external.rawUrl,
                                            htmlUrl: external.htmlUrl,
                                        },
                                    }),
                                });
                                continue;
                            }

                            const upload = yield* putGraphFile(
                                existingGraph.id,
                                fileId,
                                name,
                                source.file.content,
                                env.S3_BUCKET
                            );
                            uploadedFiles.push({
                                id: fileId,
                                name,
                                size: source.file.size,
                                type: "code",
                                mimeType: "text/plain",
                                key: upload.key,
                                storageKind: "internal",
                                checksum: source.checksum,
                                metadata: serializeCodeFileMetadata({
                                    repositoryUrl: source.repository.url,
                                    repositoryName: source.repository.name,
                                    commitSha: source.repository.commitSha,
                                    path: source.file.path,
                                }),
                            });
                        }
                    }),
                    {
                        onFailure: (uploadError) =>
                            Effect.gen(function* () {
                                const failedDeletes = yield* cleanupUploadedKeys(
                                    uploadedFiles
                                        .filter((file) => file.storageKind !== "external")
                                        .map((file) => file.key)
                                );
                                logError("graph repository URL add failed during file upload", {
                                    graphId: existingGraph.id,
                                    uploadedKeyCount: uploadedFiles.length,
                                    failedS3CleanupCount: failedDeletes,
                                    error: uploadError,
                                });
                                return yield* Effect.fail(internalServerError());
                            }),
                        onSuccess: Effect.succeed,
                    }
                );

                const result = yield* Effect.matchEffect(
                    commitGraphFileUploads({
                        graph: existingGraph,
                        uploadedFiles,
                        supersedeRepositoryUrls: repositories.map((repository) => repository.url),
                    }),
                    {
                        onFailure: (dbPatchError) =>
                            Effect.gen(function* () {
                                const failedDeletes = yield* cleanupUploadedKeys(
                                    uploadedFiles
                                        .filter((file) => file.storageKind !== "external")
                                        .map((file) => file.key)
                                );
                                logError("graph repository URL add failed during database update", {
                                    graphId: existingGraph.id,
                                    uploadedKeyCount: uploadedFiles.length,
                                    failedS3CleanupCount: failedDeletes,
                                    error: dbPatchError,
                                });
                                return yield* Effect.fail(internalServerError());
                            }),
                        onSuccess: Effect.succeed,
                    }
                );

                if (result.addedFiles.length === 0) {
                    return { graph: result.graph, addedFiles: result.addedFiles, workflowRunId: null };
                }

                return yield* Effect.matchEffect(
                    Effect.gen(function* () {
                        if (!result.processRunId) {
                            return yield* Effect.fail(
                                new ProcessRunCreationError({ message: "Missing process run id" })
                            );
                        }

                        const handle = yield* Effect.tryPromise({
                            try: () =>
                                ow.runWorkflow(processFilesSpec, {
                                    graphId: existingGraph.id,
                                    fileIds: result.addedFiles.map((file) => file.id),
                                    processRunId: result.processRunId!,
                                    code: { kind: "repository", retiredFileIds: result.supersededFileIds },
                                }),
                            catch: (cause) =>
                                new ProcessFilesWorkflowEnqueueError({
                                    message: "Failed to enqueue process files workflow",
                                    cause,
                                }),
                        });

                        return {
                            graph: result.graph,
                            addedFiles: result.addedFiles,
                            workflowRunId: handle.workflowRun.id,
                        };
                    }),
                    {
                        onFailure: (enqueueError) =>
                            Effect.gen(function* () {
                                yield* restoreGraphFileChangeFailure(
                                    existingGraph.id,
                                    existingGraph,
                                    result.addedFiles.map((file) => file.id),
                                    uploadedFiles
                                        .filter((file) => file.storageKind !== "external")
                                        .map((file) => file.key),
                                    result.processRunId,
                                    result.supersededFileIds
                                );
                                logError("graph repository URL add failed during workflow enqueue", {
                                    graphId: existingGraph.id,
                                    uploadedKeyCount: uploadedFiles.length,
                                    addedFileCount: result.addedFiles.length,
                                    error: enqueueError,
                                });
                                return yield* Effect.fail(internalServerError());
                            }),
                        onSuccess: Effect.succeed,
                    }
                );
            }),
            toApiError
        )
);
