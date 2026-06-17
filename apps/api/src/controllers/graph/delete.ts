import { eq, inArray } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { filesTable, graphTable } from "@kiwi/db/tables/graph";
import { deleteFile, listFiles } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import type { GraphDeleteSuccessData } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError } from "@kiwi/contracts/errors";
import { env } from "../../env";
import { chunk } from "../../lib/array";
import { collectGraphClosure } from "../../lib/graph";
import { assertCanPatchGraph } from "../../lib/graph/access";
import { cancelActiveGraphWorkflowRuns } from "../../lib/workflow-cancellation";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

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
    return tryApiPromise(async (): Promise<GraphDeleteSuccessData> => {
        await Effect.runPromise(assertCanPatchGraph(input.user, input.graphId));

        let graphIds: string[];
        try {
            graphIds = await Effect.runPromise(collectGraphClosure(db, [input.graphId]));
        } catch {
            throw internalServerError();
        }

        try {
            await Effect.runPromise(cancelActiveGraphWorkflowRuns(graphIds));
        } catch (cancellationError) {
            logError("graph workflow cancellation failed before graph delete", {
                graphId: input.graphId,
                graphCount: graphIds.length,
                error: cancellationError,
            });
            throw internalServerError();
        }

        const deleteResult = await db.transaction(async (tx): Promise<DeletedGraphData> => {
            const [graph] = await tx
                .select({ id: graphTable.id })
                .from(graphTable)
                .where(eq(graphTable.id, input.graphId))
                .limit(1);

            if (!graph) {
                throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
            }

            const graphIdsInTransaction = await Effect.runPromise(collectGraphClosure(tx, [input.graphId]));
            const fileRows = await tx
                .select({ id: filesTable.id, graphId: filesTable.graphId, key: filesTable.key })
                .from(filesTable)
                .where(inArray(filesTable.graphId, graphIdsInTransaction));

            await tx.delete(graphTable).where(eq(graphTable.id, input.graphId));

            return { graphId: input.graphId, graphIds: graphIdsInTransaction, fileRows };
        });

        const s3Keys = new Set(deleteResult.fileRows.map((file) => file.key));
        const listedKeyResults = await Promise.allSettled(
            deleteResult.graphIds.map((graphId) => Effect.runPromise(listFiles(`graphs/${graphId}/`, env.S3_BUCKET)))
        );

        let listFailureCount = 0;
        for (const result of listedKeyResults) {
            if (result.status === "fulfilled") {
                for (const key of result.value) {
                    s3Keys.add(key);
                }
                continue;
            }
            listFailureCount += 1;
        }

        let deleteFailureCount = 0;
        for (const keys of chunk([...s3Keys], 25)) {
            const deleteResults = await Promise.allSettled(keys.map((key) => Effect.runPromise(deleteFile(key, env.S3_BUCKET))));
            for (const result of deleteResults) {
                if (result.status === "rejected") {
                    deleteFailureCount += 1;
                }
            }
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
    });
}
