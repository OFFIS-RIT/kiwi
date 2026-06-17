import { and, eq, inArray } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { filesTable, graphTable } from "@kiwi/db/tables/graph";
import { error as logError } from "@kiwi/logger";
import { deleteGraphFilesSpec } from "@kiwi/worker/delete-graph-files-spec";
import type { GraphDeleteFilesFields, GraphDeleteFilesSuccessData } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError, makeApiError, noChangesError } from "@kiwi/contracts/errors";
import { assertCanManageGraphFiles, selectGraphFields } from "../../lib/graph/access";
import { cancelActiveFileProcessingWorkflowRuns } from "../../lib/workflow-cancellation";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { tryApiPromise } from "../_shared/api-effect";

function normalizeFileKeys(fileKeys: GraphDeleteFilesFields["fileKeys"]) {
    return fileKeys ? [...new Set((Array.isArray(fileKeys) ? fileKeys : [fileKeys]).filter((fileKey) => fileKey.length > 0))] : [];
}

export function deleteGraphFiles(input: { user: AuthUser; graphId: string; body: GraphDeleteFilesFields }) {
    return tryApiPromise(async (): Promise<GraphDeleteFilesSuccessData> => {
        const existingGraph = await Effect.runPromise(assertCanManageGraphFiles(input.user, input.graphId));
        const fileKeys = normalizeFileKeys(input.body.fileKeys);
        if (fileKeys.length === 0) {
            throw noChangesError();
        }

        const existingFiles = await db
            .select({ id: filesTable.id, key: filesTable.key })
            .from(filesTable)
            .where(and(eq(filesTable.graphId, existingGraph.id), eq(filesTable.deleted, false)));
        const fileIdByKey = new Map(existingFiles.map((file) => [file.key, file.id]));
        if (fileKeys.some((fileKey) => !fileIdByKey.has(fileKey))) {
            throw makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "Invalid file IDs");
        }

        const fileIds = fileKeys.map((fileKey) => fileIdByKey.get(fileKey)!);
        let graph = existingGraph;
        try {
            const [updatedGraph] = await db.transaction(async (tx) => {
                const updatedGraphs = await tx
                    .update(graphTable)
                    .set({ state: "updating" })
                    .where(eq(graphTable.id, existingGraph.id))
                    .returning(selectGraphFields);

                await tx
                    .update(filesTable)
                    .set({ deleted: true })
                    .where(and(eq(filesTable.graphId, existingGraph.id), inArray(filesTable.id, fileIds)));

                return updatedGraphs;
            });
            graph = updatedGraph ?? existingGraph;
        } catch (dbPatchError) {
            logError("graph file delete failed during database update", {
                graphId: existingGraph.id,
                removedFileCount: fileKeys.length,
                error: dbPatchError,
            });
            throw internalServerError();
        }

        try {
            const handle = await ow.runWorkflow(deleteGraphFilesSpec, { graphId: existingGraph.id, fileIds });
            try {
                await Effect.runPromise(cancelActiveFileProcessingWorkflowRuns(existingGraph.id, fileIds));
            } catch (cancellationError) {
                logError("graph file processing workflow cancellation failed after delete enqueue", {
                    graphId: existingGraph.id,
                    removedFileCount: fileKeys.length,
                    workflowRunId: handle.workflowRun.id,
                    error: cancellationError,
                });
            }

            return { graph, removedFileKeys: fileKeys, workflowRunId: handle.workflowRun.id };
        } catch (enqueueError) {
            try {
                await db.transaction(async (tx) => {
                    await tx
                        .update(filesTable)
                        .set({ deleted: false })
                        .where(and(eq(filesTable.graphId, existingGraph.id), inArray(filesTable.id, fileIds)));
                    await tx.update(graphTable).set({ state: existingGraph.state }).where(eq(graphTable.id, existingGraph.id));
                });
            } catch (restoreError) {
                logError("failed to restore graph state after file delete enqueue failure", {
                    graphId: existingGraph.id,
                    removedFileCount: fileKeys.length,
                    error: restoreError,
                });
            }

            logError("graph file delete failed during workflow enqueue", {
                graphId: existingGraph.id,
                removedFileCount: fileKeys.length,
                error: enqueueError,
            });
            throw internalServerError();
        }
    });
}
