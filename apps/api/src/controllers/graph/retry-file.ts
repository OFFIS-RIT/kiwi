import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import type { GraphFileRetrySuccessData } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError, makeApiError } from "@kiwi/contracts/errors";
import { assertCanManageGraphFiles, selectGraphFields, type GraphRecord } from "../../lib/graph/access";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { tryApiPromise } from "../_shared/api-effect";

type RetryPreparation = {
    graph: GraphRecord;
    runId: string;
};

export function retryGraphFile(input: { user: AuthUser; graphId: string; fileId: string }) {
    return tryApiPromise(async (): Promise<GraphFileRetrySuccessData> => {
        const existingGraph = await Effect.runPromise(assertCanManageGraphFiles(input.user, input.graphId));
        const [file] = await db
            .select({
                id: filesTable.id,
                type: filesTable.type,
                status: filesTable.status,
                processStep: filesTable.processStep,
                processErrorCode: filesTable.processErrorCode,
            })
            .from(filesTable)
            .where(
                and(
                    eq(filesTable.graphId, existingGraph.id),
                    eq(filesTable.id, input.fileId),
                    eq(filesTable.deleted, false)
                )
            )
            .limit(1);

        if (!file) {
            throw makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "Invalid file IDs");
        }
        if (file.processStep !== "failed") {
            throw makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "File is not in a failed state");
        }

        let retry: RetryPreparation;
        try {
            retry = await db.transaction(async (tx) => {
                const [updatedGraph] = await tx
                    .update(graphTable)
                    .set({ state: "updating" })
                    .where(eq(graphTable.id, existingGraph.id))
                    .returning(selectGraphFields);

                const [processRun] = await tx
                    .insert(processRunsTable)
                    .values({ graphId: existingGraph.id, status: "pending" })
                    .returning({ id: processRunsTable.id });
                if (!processRun) {
                    throw new Error("Failed to create process run");
                }

                await tx.insert(processRunFilesTable).values({ processRunId: processRun.id, fileId: file.id });
                await tx
                    .update(filesTable)
                    .set({ status: "processing", processStep: "pending", processErrorCode: null })
                    .where(eq(filesTable.id, file.id));

                return { graph: updatedGraph ?? existingGraph, runId: processRun.id };
            });
        } catch (dbPatchError) {
            logError("graph file retry failed during database update", {
                graphId: existingGraph.id,
                fileId: file.id,
                error: dbPatchError,
            });
            throw internalServerError();
        }

        try {
            const handle = await ow.runWorkflow(processFilesSpec, {
                graphId: existingGraph.id,
                fileIds: [file.id],
                processRunId: retry.runId,
                ...(file.type === "code" ? { code: { kind: "repository" as const } } : {}),
            });

            return { graph: retry.graph, fileId: file.id, workflowRunId: handle.workflowRun.id };
        } catch (enqueueError) {
            try {
                await db.transaction(async (tx) => {
                    await tx.delete(processRunsTable).where(eq(processRunsTable.id, retry.runId));
                    await tx.update(graphTable).set({ state: existingGraph.state }).where(eq(graphTable.id, existingGraph.id));
                    await tx
                        .update(filesTable)
                        .set({
                            status: file.status,
                            processStep: file.processStep,
                            processErrorCode: file.processErrorCode,
                        })
                        .where(eq(filesTable.id, file.id));
                });
            } catch (restoreError) {
                logError("failed to restore graph state after file retry enqueue failure", {
                    graphId: existingGraph.id,
                    fileId: file.id,
                    error: restoreError,
                });
            }

            logError("graph file retry failed during workflow enqueue", {
                graphId: existingGraph.id,
                fileId: file.id,
                error: enqueueError,
            });
            throw internalServerError();
        }
    });
}
