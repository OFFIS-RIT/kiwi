import { eq, inArray } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { filesTable, graphTable } from "@kiwi/db/tables/graph";
import { deleteFile, listFiles } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { API_ERROR_CODES, internalServerError } from "@kiwi/contracts/errors";
import { env } from "../../env";
import { chunk } from "../../lib/array";
import { assertCanPatchGraph } from "../../lib/graph/access";
import { cancelActiveGraphWorkflowRuns } from "../../lib/workflow-cancellation";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

type DeletedGraphFileRow = {
    id: string;
    graphId: string;
    key: string;
};

type DeletedGraphData = {
    graphId: string;
    graphIds: string[];
    fileRows: DeletedGraphFileRow[];
};

export function deleteGraph(input: { user: AuthUser; graphId: string }) {
    return Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
        yield* assertCanPatchGraph(input.user, input.graphId);

        const graphIds = yield* Effect.matchEffect(
            tryDb((db) =>
                Effect.gen(function* () {
                    const graphIds = new Set([input.graphId]);
                    let frontier = [...graphIds];

                    while (frontier.length > 0) {
                        const childRows = yield* db
                            .select({ id: graphTable.id })
                            .from(graphTable)
                            .where(inArray(graphTable.graphId, frontier));

                        const nextFrontier: string[] = [];
                        for (const child of childRows) {
                            if (graphIds.has(child.id)) {
                                continue;
                            }

                            graphIds.add(child.id);
                            nextFrontier.push(child.id);
                        }

                        frontier = nextFrontier;
                    }

                    return [...graphIds];
                })
            ),
            {
                onFailure: () => Effect.fail(internalServerError()),
                onSuccess: Effect.succeed,
            }
        );

        yield* Effect.matchEffect(cancelActiveGraphWorkflowRuns(graphIds), {
            onFailure: (cancellationError) =>
                Effect.gen(function* () {
                    logError("graph workflow cancellation failed before graph delete", {
                        graphId: input.graphId,
                        graphCount: graphIds.length,
                        error: cancellationError,
                    });
                    return yield* Effect.fail(internalServerError());
                }),
            onSuccess: () => Effect.void,
        });

        const deleteResult = yield* tryDb((db) =>
            db.transaction((tx) =>
                Effect.gen(function* (): Generator<Effect.Effect<unknown, unknown>, DeletedGraphData> {
                    const [graph] = yield* tx
                        .select({ id: graphTable.id })
                        .from(graphTable)
                        .where(eq(graphTable.id, input.graphId))
                        .limit(1);

                    if (!graph) {
                        return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
                    }

                    const graphIdsInTransaction = new Set([input.graphId]);
                    let frontier = [...graphIdsInTransaction];

                    while (frontier.length > 0) {
                        const childRows = yield* tx
                            .select({ id: graphTable.id })
                            .from(graphTable)
                            .where(inArray(graphTable.graphId, frontier));

                        const nextFrontier: string[] = [];
                        for (const child of childRows) {
                            if (graphIdsInTransaction.has(child.id)) {
                                continue;
                            }

                            graphIdsInTransaction.add(child.id);
                            nextFrontier.push(child.id);
                        }

                        frontier = nextFrontier;
                    }

                    const fileRows = yield* tx
                        .select({ id: filesTable.id, graphId: filesTable.graphId, key: filesTable.key })
                        .from(filesTable)
                        .where(inArray(filesTable.graphId, [...graphIdsInTransaction]));

                    yield* tx.delete(graphTable).where(eq(graphTable.id, input.graphId));

                    return { graphId: input.graphId, graphIds: [...graphIdsInTransaction], fileRows };
                })
            )
        );

        const s3Keys = new Set(deleteResult.fileRows.map((file) => file.key));
        const listedKeyResults = yield* Effect.all(
            deleteResult.graphIds.map((graphId) =>
                Effect.match(listFiles(`graphs/${graphId}/`, env.S3_BUCKET), {
                    onFailure: () => ({ ok: false as const }),
                    onSuccess: (keys) => ({ ok: true as const, keys }),
                })
            ),
            { concurrency: "unbounded" }
        );

        let listFailureCount = 0;
        for (const result of listedKeyResults) {
            if (result.ok) {
                for (const key of result.keys) {
                    s3Keys.add(key);
                }
                continue;
            }
            listFailureCount += 1;
        }

        let deleteFailureCount = 0;
        for (const keys of chunk([...s3Keys], 25)) {
            const deleteResults = yield* Effect.all(
                keys.map((key) =>
                    Effect.match(deleteFile(key, env.S3_BUCKET), {
                        onFailure: () => false,
                        onSuccess: () => true,
                    })
                ),
                { concurrency: "unbounded" }
            );
            deleteFailureCount += deleteResults.filter((deleted) => !deleted).length;
        }

        const failedKeyCount = listFailureCount + deleteFailureCount;
        if (failedKeyCount > 0) {
            logError("Graph deleted with incomplete S3 cleanup", {
                graphId: deleteResult.graphId,
                graphCount: deleteResult.graphIds.length,
                attemptedKeyCount: s3Keys.size,
                failedKeyCount,
            });
        }

        return {
            graphId: deleteResult.graphId,
            deletedGraphCount: deleteResult.graphIds.length,
            deletedFileCount: deleteResult.fileRows.length,
            s3Cleanup: {
                attemptedKeyCount: s3Keys.size,
                failedKeyCount,
            },
            ...(failedKeyCount > 0
                ? { warnings: ["Some S3 objects could not be deleted after the graph was removed"] }
                : {}),
        };
    }), (defect) => Effect.fail(defect)), toApiError);
}
