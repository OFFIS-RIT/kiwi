import { and, eq } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { tryDb, tryDbVoid } from "@kiwi/db/effect";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import { API_ERROR_CODES, internalServerError, makeApiError } from "@kiwi/contracts/errors";
import { assertCanManageGraphFiles, selectGraphFields } from "../../lib/graph/access";
import type { AuthUser } from "../../middleware/auth";
import { wo } from "../../workflow";
import { toApiError } from "../_shared/api-effect";

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

export const retryGraphFile = Effect.fn("retryGraphFile")(
    (input: { user: AuthUser; graphId: string; fileId: string }) =>
        Effect.mapError(
            Effect.gen(function* () {
                const existingGraph = yield* assertCanManageGraphFiles(input.user, input.graphId);
                const [file] = yield* tryDb((db) =>
                    db
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
                        .limit(1)
                );

                if (!file) {
                    return yield* Effect.fail(makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "Invalid file IDs"));
                }
                if (file.processStep !== "failed") {
                    return yield* Effect.fail(
                        makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "File is not in a failed state")
                    );
                }

                const retry = yield* Effect.matchEffect(
                    tryDb((db) =>
                        db.transaction((tx) =>
                            Effect.gen(function* () {
                                const [updatedGraph] = yield* tx
                                    .update(graphTable)
                                    .set({ state: "updating" })
                                    .where(eq(graphTable.id, existingGraph.id))
                                    .returning(selectGraphFields);

                                const [processRun] = yield* tx
                                    .insert(processRunsTable)
                                    .values({ graphId: existingGraph.id, status: "pending" })
                                    .returning({ id: processRunsTable.id });
                                if (!processRun) {
                                    return yield* Effect.fail(
                                        new ProcessRunCreationError({ message: "Failed to create process run" })
                                    );
                                }

                                yield* tx
                                    .insert(processRunFilesTable)
                                    .values({ processRunId: processRun.id, fileId: file.id });
                                yield* tx
                                    .update(filesTable)
                                    .set({ status: "processing", processStep: "pending", processErrorCode: null })
                                    .where(eq(filesTable.id, file.id));

                                return { graph: updatedGraph ?? existingGraph, runId: processRun.id };
                            })
                        )
                    ),
                    {
                        onFailure: (dbPatchError) =>
                            Effect.gen(function* () {
                                logError("graph file retry failed during database update", {
                                    graphId: existingGraph.id,
                                    fileId: file.id,
                                    error: dbPatchError,
                                });
                                return yield* Effect.fail(internalServerError());
                            }),
                        onSuccess: Effect.succeed,
                    }
                );

                return yield* Effect.matchEffect(
                    Effect.gen(function* () {
                        const handle = yield* Effect.tryPromise({
                            try: () =>
                                wo.runWorkflow(processFilesSpec, {
                                    graphId: existingGraph.id,
                                    fileIds: [file.id],
                                    processRunId: retry.runId,
                                    ...(file.type === "code"
                                        ? { code: { kind: "repository" as const, retiredFileIds: [] } }
                                        : {}),
                                }),
                            catch: (cause) =>
                                new ProcessFilesWorkflowEnqueueError({
                                    message: "Failed to enqueue process files workflow",
                                    cause,
                                }),
                        });

                        return { graph: retry.graph, fileId: file.id, workflowRunId: handle.workflowRun.id };
                    }),
                    {
                        onFailure: (enqueueError) =>
                            Effect.gen(function* () {
                                yield* Effect.matchEffect(
                                    tryDbVoid((db) =>
                                        db.transaction((tx) =>
                                            Effect.gen(function* () {
                                                yield* tx
                                                    .delete(processRunsTable)
                                                    .where(eq(processRunsTable.id, retry.runId));
                                                yield* tx
                                                    .update(graphTable)
                                                    .set({ state: existingGraph.state })
                                                    .where(eq(graphTable.id, existingGraph.id));
                                                yield* tx
                                                    .update(filesTable)
                                                    .set({
                                                        status: file.status,
                                                        processStep: file.processStep,
                                                        processErrorCode: file.processErrorCode,
                                                    })
                                                    .where(eq(filesTable.id, file.id));
                                            })
                                        )
                                    ),
                                    {
                                        onFailure: (restoreError) =>
                                            Effect.sync(() => {
                                                logError(
                                                    "failed to restore graph state after file retry enqueue failure",
                                                    {
                                                        graphId: existingGraph.id,
                                                        fileId: file.id,
                                                        error: restoreError,
                                                    }
                                                );
                                            }),
                                        onSuccess: () => Effect.void,
                                    }
                                );

                                logError("graph file retry failed during workflow enqueue", {
                                    graphId: existingGraph.id,
                                    fileId: file.id,
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
