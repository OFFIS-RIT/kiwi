import { and, eq, inArray } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
import { tryDb, tryDbVoid } from "@kiwi/db/effect";
import { filesTable, graphTable } from "@kiwi/db/tables/graph";
import { error as logError } from "@kiwi/logger";
import { deleteGraphFilesSpec } from "@kiwi/worker/delete-graph-files-spec";
import type { GraphDeleteFilesFields } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError, makeApiError, noChangesError } from "@kiwi/contracts/errors";
import { assertCanManageGraphFiles, selectGraphFields } from "../../lib/graph/access";
import { cancelActiveFileProcessingWorkflowRuns } from "../../lib/workflow-cancellation";
import type { AuthUser } from "../../middleware/auth";
import { wo } from "../../workflow";
import { toApiError } from "../_shared/api-effect";

function normalizeFileKeys(fileKeys: GraphDeleteFilesFields["fileKeys"]) {
    return fileKeys
        ? [...new Set((Array.isArray(fileKeys) ? fileKeys : [fileKeys]).filter((fileKey) => fileKey.length > 0))]
        : [];
}

export function deleteGraphFiles(input: { user: AuthUser; graphId: string; body: GraphDeleteFilesFields }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                const existingGraph = yield* assertCanManageGraphFiles(input.user, input.graphId);
                const fileKeys = normalizeFileKeys(input.body.fileKeys);
                if (fileKeys.length === 0) {
                    return yield* Effect.fail(noChangesError());
                }

                const existingFiles = yield* tryDb((db) =>
                    db
                        .select({ id: filesTable.id, key: filesTable.key })
                        .from(filesTable)
                        .where(and(eq(filesTable.graphId, existingGraph.id), eq(filesTable.deleted, false)))
                );
                const fileIdByKey = new Map(existingFiles.map((file) => [file.key, file.id]));
                if (fileKeys.some((fileKey) => !fileIdByKey.has(fileKey))) {
                    return yield* Effect.fail(makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "Invalid file IDs"));
                }

                const fileIds = fileKeys.map((fileKey) => fileIdByKey.get(fileKey)!);
                const graph = yield* Effect.matchEffect(
                    tryDb((db) =>
                        db.transaction((tx) =>
                            Effect.gen(function* () {
                                const updatedGraphs = yield* tx
                                    .update(graphTable)
                                    .set({ state: "updating" })
                                    .where(eq(graphTable.id, existingGraph.id))
                                    .returning(selectGraphFields);

                                yield* tx
                                    .update(filesTable)
                                    .set({ deleted: true })
                                    .where(
                                        and(eq(filesTable.graphId, existingGraph.id), inArray(filesTable.id, fileIds))
                                    );

                                return updatedGraphs[0] ?? existingGraph;
                            })
                        )
                    ),
                    {
                        onFailure: (dbPatchError) =>
                            Effect.gen(function* () {
                                logError("graph file delete failed during database update", {
                                    graphId: existingGraph.id,
                                    removedFileCount: fileKeys.length,
                                    error: dbPatchError,
                                });
                                return yield* Effect.fail(internalServerError());
                            }),
                        onSuccess: Effect.succeed,
                    }
                );

                return yield* Effect.matchEffect(
                    Effect.catchDefect(
                        Effect.gen(function* () {
                            const handle = yield* Effect.tryPromise({
                                try: () => wo.runWorkflow(deleteGraphFilesSpec, { graphId: existingGraph.id, fileIds }),
                                catch: (error) => error,
                            });
                            yield* Effect.matchEffect(
                                cancelActiveFileProcessingWorkflowRuns(existingGraph.id, fileIds),
                                {
                                    onFailure: (cancellationError) =>
                                        Effect.sync(() => {
                                            logError(
                                                "graph file processing workflow cancellation failed after delete enqueue",
                                                {
                                                    graphId: existingGraph.id,
                                                    removedFileCount: fileKeys.length,
                                                    workflowRunId: handle.workflowRun.id,
                                                    error: cancellationError,
                                                }
                                            );
                                        }),
                                    onSuccess: () => Effect.void,
                                }
                            );

                            return { graph, removedFileKeys: fileKeys, workflowRunId: handle.workflowRun.id };
                        }),
                        (defect) => Effect.fail(defect)
                    ),
                    {
                        onFailure: (enqueueError) =>
                            Effect.gen(function* () {
                                yield* Effect.matchEffect(
                                    tryDbVoid((db) =>
                                        db.transaction((tx) =>
                                            Effect.gen(function* () {
                                                yield* tx
                                                    .update(filesTable)
                                                    .set({ deleted: false })
                                                    .where(
                                                        and(
                                                            eq(filesTable.graphId, existingGraph.id),
                                                            inArray(filesTable.id, fileIds)
                                                        )
                                                    );
                                                yield* tx
                                                    .update(graphTable)
                                                    .set({ state: existingGraph.state })
                                                    .where(eq(graphTable.id, existingGraph.id));
                                            })
                                        )
                                    ),
                                    {
                                        onFailure: (restoreError) =>
                                            Effect.sync(() => {
                                                logError(
                                                    "failed to restore graph state after file delete enqueue failure",
                                                    {
                                                        graphId: existingGraph.id,
                                                        removedFileCount: fileKeys.length,
                                                        error: restoreError,
                                                    }
                                                );
                                            }),
                                        onSuccess: () => Effect.void,
                                    }
                                );

                                logError("graph file delete failed during workflow enqueue", {
                                    graphId: existingGraph.id,
                                    removedFileCount: fileKeys.length,
                                    error: enqueueError,
                                });
                                return yield* Effect.fail(internalServerError());
                            }),
                        onSuccess: Effect.succeed,
                    }
                );
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}
