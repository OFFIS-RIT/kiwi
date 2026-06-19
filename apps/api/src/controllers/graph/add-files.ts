import { and, eq, isNotNull } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ulid } from "ulid";
import { tryDb } from "@kiwi/db/effect";
import { filesTable } from "@kiwi/db/tables/graph";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import { API_ERROR_CODES, internalServerError, makeApiError } from "@kiwi/contracts/errors";
import { env } from "../../env";
import { expandArchiveUploadFiles } from "../../lib/archive-upload";
import { assertCanManageGraphFiles } from "../../lib/graph/access";
import {
    assertConfiguredUploadModels,
    cleanupUploadedKeys,
    commitGraphFileUploads,
    inferSupportedUploadedFiles,
    restoreGraphFileChangeFailure,
    uniqueFilesByChecksum,
    type UploadedFile,
} from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { toApiError } from "../_shared/api-effect";
import { archiveUploadError, getGraphOwnerModelOrganizationId, unsupportedUploadError } from "./upload-helpers";

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

export const addGraphFiles = Effect.fn("addGraphFiles")((input: { user: AuthUser; graphId: string; files: File[] }) =>
    Effect.mapError(
        Effect.gen(function* () {
            const existingGraph = yield* assertCanManageGraphFiles(input.user, input.graphId);
            if (input.files.length === 0) {
                return yield* Effect.fail(makeApiError(400, API_ERROR_CODES.NO_CHANGES, "No changes requested"));
            }

            const expanded = yield* expandArchiveUploadFiles(input.files);
            if (!expanded.ok) {
                return yield* Effect.fail(archiveUploadError(expanded));
            }

            const uniqueUploadedFiles = yield* uniqueFilesByChecksum(expanded.files);
            if (uniqueUploadedFiles.length === 0) {
                return { graph: existingGraph, addedFiles: [], workflowRunId: null };
            }

            const existingFiles = yield* tryDb((db) =>
                db
                    .select({ checksum: filesTable.checksum })
                    .from(filesTable)
                    .where(
                        and(
                            eq(filesTable.graphId, existingGraph.id),
                            eq(filesTable.deleted, false),
                            isNotNull(filesTable.checksum)
                        )
                    )
            );
            const existingChecksums = new Set(
                existingFiles.map((file) => file.checksum).filter((checksum) => checksum !== null)
            );
            const filesWithChecksums = uniqueUploadedFiles.filter((file) => !existingChecksums.has(file.checksum));
            if (filesWithChecksums.length === 0) {
                return { graph: existingGraph, addedFiles: [], workflowRunId: null };
            }

            const supportedUpload = inferSupportedUploadedFiles(filesWithChecksums);
            if (!supportedUpload.ok) {
                return yield* Effect.fail(unsupportedUploadError(supportedUpload));
            }

            const organizationId = yield* getGraphOwnerModelOrganizationId({
                ownerMode: "graph",
                graphId: existingGraph.id,
            });
            yield* assertConfiguredUploadModels({
                organizationId,
                files: supportedUpload.files,
                secret: env.AUTH_SECRET,
            });

            const uploadedFiles: UploadedFile[] = [];
            yield* Effect.matchEffect(
                Effect.gen(function* () {
                    for (const { file, checksum, type } of supportedUpload.files) {
                        const fileId = ulid();
                        const upload = yield* putGraphFile(existingGraph.id, fileId, file.name, file, env.S3_BUCKET);
                        uploadedFiles.push({
                            id: fileId,
                            name: file.name,
                            size: file.size,
                            type,
                            mimeType: file.type || upload.type,
                            key: upload.key,
                            checksum,
                        });
                    }
                }),
                {
                    onFailure: (uploadError) =>
                        Effect.gen(function* () {
                            const failedDeletes = yield* cleanupUploadedKeys(uploadedFiles.map((file) => file.key));
                            logError("graph file add failed during file upload", {
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

            const result = yield* Effect.matchEffect(commitGraphFileUploads({ graph: existingGraph, uploadedFiles }), {
                onFailure: (dbPatchError) =>
                    Effect.gen(function* () {
                        const failedDeletes = yield* cleanupUploadedKeys(uploadedFiles.map((file) => file.key));
                        logError("graph file add failed during database update", {
                            graphId: existingGraph.id,
                            uploadedKeyCount: uploadedFiles.length,
                            failedS3CleanupCount: failedDeletes,
                            error: dbPatchError,
                        });
                        return yield* Effect.fail(internalServerError());
                    }),
                onSuccess: Effect.succeed,
            });

            if (result.addedFiles.length === 0) {
                return { graph: result.graph, addedFiles: result.addedFiles, workflowRunId: null };
            }

            return yield* Effect.matchEffect(
                Effect.gen(function* () {
                    if (!result.processRunId) {
                        return yield* Effect.fail(new ProcessRunCreationError({ message: "Missing process run id" }));
                    }

                    const handle = yield* Effect.tryPromise({
                        try: () =>
                            ow.runWorkflow(processFilesSpec, {
                                graphId: existingGraph.id,
                                fileIds: result.addedFiles.map((file) => file.id),
                                processRunId: result.processRunId!,
                            }),
                        catch: (cause) =>
                            new ProcessFilesWorkflowEnqueueError({
                                message: "Failed to enqueue process files workflow",
                                cause,
                            }),
                    });

                    return { graph: result.graph, addedFiles: result.addedFiles, workflowRunId: handle.workflowRun.id };
                }),
                {
                    onFailure: (enqueueError) =>
                        Effect.gen(function* () {
                            yield* restoreGraphFileChangeFailure(
                                existingGraph.id,
                                existingGraph,
                                result.addedFiles.map((file) => file.id),
                                uploadedFiles.map((file) => file.key),
                                result.processRunId
                            );
                            logError("graph file add failed during workflow enqueue", {
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
