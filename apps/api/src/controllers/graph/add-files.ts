import { and, eq, isNotNull } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { ulid } from "ulid";
import { db } from "@kiwi/db";
import { filesTable } from "@kiwi/db/tables/graph";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import type { GraphAddFilesSuccessData } from "@kiwi/contracts/graphs";
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
    type GraphFileUploadCommit,
    type UploadedFile,
} from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { tryApiPromise } from "../_shared/api-effect";
import { archiveUploadError, getGraphOwnerModelOrganizationId, unsupportedUploadError } from "./upload-helpers";

export function addGraphFiles(input: { user: AuthUser; graphId: string; files: File[] }) {
    return tryApiPromise(async (): Promise<GraphAddFilesSuccessData> => {
        const existingGraph = await Effect.runPromise(assertCanManageGraphFiles(input.user, input.graphId));
        if (input.files.length === 0) {
            throw makeApiError(400, API_ERROR_CODES.NO_CHANGES, "No changes requested");
        }

        const expanded = await Effect.runPromise(expandArchiveUploadFiles(input.files));
        if (!expanded.ok) {
            throw archiveUploadError(expanded);
        }

        const uniqueUploadedFiles = await Effect.runPromise(uniqueFilesByChecksum(expanded.files));
        if (uniqueUploadedFiles.length === 0) {
            return { graph: existingGraph, addedFiles: [], workflowRunId: null };
        }

        const existingFiles = await db
            .select({ checksum: filesTable.checksum })
            .from(filesTable)
            .where(
                and(eq(filesTable.graphId, existingGraph.id), eq(filesTable.deleted, false), isNotNull(filesTable.checksum))
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
            throw unsupportedUploadError(supportedUpload);
        }

        await Effect.runPromise(assertConfiguredUploadModels({
            organizationId: await Effect.runPromise(
                getGraphOwnerModelOrganizationId({ ownerMode: "graph", graphId: existingGraph.id })
            ),
            files: supportedUpload.files,
            secret: env.AUTH_SECRET,
        }));

        const uploadedFiles: UploadedFile[] = [];
        try {
            for (const { file, checksum, type } of supportedUpload.files) {
                const fileId = ulid();
                const upload = await Effect.runPromise(putGraphFile(existingGraph.id, fileId, file.name, file, env.S3_BUCKET));
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
        } catch (uploadError) {
            const failedDeletes = await Effect.runPromise(cleanupUploadedKeys(uploadedFiles.map((file) => file.key)));
            logError("graph file add failed during file upload", {
                graphId: existingGraph.id,
                uploadedKeyCount: uploadedFiles.length,
                failedS3CleanupCount: failedDeletes,
                error: uploadError,
            });
            throw internalServerError();
        }

        let result: GraphFileUploadCommit;
        try {
            result = await Effect.runPromise(commitGraphFileUploads({ graph: existingGraph, uploadedFiles }));
        } catch (dbPatchError) {
            const failedDeletes = await Effect.runPromise(cleanupUploadedKeys(uploadedFiles.map((file) => file.key)));
            logError("graph file add failed during database update", {
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
            });

            return { graph: result.graph, addedFiles: result.addedFiles, workflowRunId: handle.workflowRun.id };
        } catch (enqueueError) {
            await Effect.runPromise(
                restoreGraphFileChangeFailure(
                    existingGraph.id,
                    existingGraph,
                    result.addedFiles.map((file) => file.id),
                    uploadedFiles.map((file) => file.key),
                    result.processRunId
                )
            );
            logError("graph file add failed during workflow enqueue", {
                graphId: existingGraph.id,
                uploadedKeyCount: uploadedFiles.length,
                addedFileCount: result.addedFiles.length,
                error: enqueueError,
            });
            throw internalServerError();
        }
    });
}
