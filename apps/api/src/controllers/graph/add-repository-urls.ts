import { ulid } from "ulid";
import * as Effect from "effect/Effect";
import { serializeCodeFileMetadata } from "@kiwi/graph/code/metadata";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import type { GraphAddFilesSuccessData, GraphAddUrlFields } from "@kiwi/contracts/graphs";
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
    type GraphFileUploadCommit,
    type UploadedFile,
} from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { tryApiPromise } from "../_shared/api-effect";
import { getGraphOwnerModelOrganizationId } from "./upload-helpers";

type RepositoryUploadSource = {
    repository: LoadedRepository;
    file: LoadedRepository["files"][number];
    checksum: string;
};

async function contentChecksum(content: string): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

export function addGraphRepositoryUrls(input: { user: AuthUser; graphId: string; body: GraphAddUrlFields }) {
    return tryApiPromise(async (): Promise<GraphAddFilesSuccessData> => {
        const existingGraph = await assertCanManageGraphFiles(input.user, input.graphId);
        const urls = [...new Set(input.body.urls.map((url) => url.trim()).filter(Boolean))];
        if (urls.length === 0) {
            throw noChangesError();
        }
        if (urls.length > MAX_REPOSITORY_URLS) {
            throw makeApiError(
                413,
                API_ERROR_CODES.UPLOAD_LIMIT_EXCEEDED,
                `At most ${MAX_REPOSITORY_URLS} repository URLs can be processed at once`
            );
        }

        let repositories: LoadedRepository[];
        try {
            repositories = [];
            for (const url of urls) {
                repositories.push(await loadRepositoryFromUrl(url));
            }
        } catch (error) {
            throw repositoryUrlError(error);
        }

        const seenSnapshotFiles = new Set<string>();
        const repositorySources: RepositoryUploadSource[] = [];
        for (const repository of repositories) {
            for (const file of repository.files) {
                const checksum = await contentChecksum(file.content);
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

        await assertConfiguredUploadModels({
            organizationId: await Effect.runPromise(
                getGraphOwnerModelOrganizationId({ ownerMode: "graph", graphId: existingGraph.id })
            ),
            files: repositorySources.map(() => ({ type: "code" as const })),
            secret: env.AUTH_SECRET,
        });

        const uploadedFiles: UploadedFile[] = [];
        try {
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

                const upload = await Effect.runPromise(
                    putGraphFile(existingGraph.id, fileId, name, source.file.content, env.S3_BUCKET)
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
        } catch (uploadError) {
            const failedDeletes = await cleanupUploadedKeys(
                uploadedFiles.filter((file) => file.storageKind !== "external").map((file) => file.key)
            );
            logError("graph repository URL add failed during file upload", {
                graphId: existingGraph.id,
                uploadedKeyCount: uploadedFiles.length,
                failedS3CleanupCount: failedDeletes,
                error: uploadError,
            });
            throw internalServerError();
        }

        let result: GraphFileUploadCommit;
        try {
            result = await commitGraphFileUploads({
                graph: existingGraph,
                uploadedFiles,
                supersedeRepositoryUrls: repositories.map((repository) => repository.url),
            });
        } catch (dbPatchError) {
            const failedDeletes = await cleanupUploadedKeys(
                uploadedFiles.filter((file) => file.storageKind !== "external").map((file) => file.key)
            );
            logError("graph repository URL add failed during database update", {
                graphId: existingGraph.id,
                uploadedKeyCount: uploadedFiles.length,
                failedS3CleanupCount: failedDeletes,
                error: dbPatchError,
            });
            throw internalServerError();
        }

        if (result.addedFiles.length === 0) {
            return { graph: result.graph, addedFiles: result.addedFiles, workflowRunId: null };
        }

        try {
            if (!result.processRunId) {
                throw new Error("Missing process run id");
            }

            const handle = await ow.runWorkflow(processFilesSpec, {
                graphId: existingGraph.id,
                fileIds: result.addedFiles.map((file) => file.id),
                processRunId: result.processRunId,
                code: { kind: "repository", retiredFileIds: result.supersededFileIds },
            });

            return { graph: result.graph, addedFiles: result.addedFiles, workflowRunId: handle.workflowRun.id };
        } catch (enqueueError) {
            await restoreGraphFileChangeFailure(
                existingGraph.id,
                existingGraph,
                result.addedFiles.map((file) => file.id),
                uploadedFiles.filter((file) => file.storageKind !== "external").map((file) => file.key),
                result.processRunId,
                result.supersededFileIds
            );
            logError("graph repository URL add failed during workflow enqueue", {
                graphId: existingGraph.id,
                uploadedKeyCount: uploadedFiles.length,
                addedFileCount: result.addedFiles.length,
                error: enqueueError,
            });
            throw internalServerError();
        }
    });
}
