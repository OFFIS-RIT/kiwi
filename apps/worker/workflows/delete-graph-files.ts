import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { eq, sql } from "drizzle-orm";
import { defineWorkflow } from "openworkflow";
import { graphTable } from "@kiwi/db/tables/graph";
import { deleteFileSpec } from "./delete-file-spec";
import { deleteGraphFilesSpec } from "./delete-graph-files-spec";

const NO_RETRY = { maximumAttempts: 1 } as const;

function workflowError(error: unknown) {
    if (error instanceof Error) {
        return new Error(error.message, { cause: error });
    }

    return new Error("Workflow failed", { cause: error });
}

function finalizeProjectStatus(graphId: string): Effect.Effect<void, unknown> {
    return Effect.tryPromise(async () => {
        await db.transaction(async (tx) => {
            await tx.execute(sql`
                UPDATE process_runs run
                SET status = 'completed',
                    completed_at = COALESCE(run.completed_at, NOW()),
                    updated_at = NOW()
                WHERE run.graph_id = ${graphId}
                  AND run.status IN ('pending', 'started')
                  AND NOT EXISTS (
                      SELECT 1
                      FROM process_run_files run_file
                      WHERE run_file.process_run_id = run.id
                  )
            `);

            await tx.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, graphId));
        });
    });
}

export const deleteGraphFiles = defineWorkflow(deleteGraphFilesSpec, async ({ input, step, run }) => {
    try {
        await step.run({ name: "update-project-status" }, async () =>
            Effect.runPromise(
                Effect.tryPromise(() =>
                    db.update(graphTable).set({ state: "updating" }).where(eq(graphTable.id, input.graphId)).then(() => undefined)
                )
            )
        );

        const deleteResults = await Promise.allSettled(
            input.fileIds.map((fileId) =>
                step.runWorkflow(deleteFileSpec, {
                    graphId: input.graphId,
                    fileId,
                })
            )
        );
        const failedDeleteCount = deleteResults.filter((result) => result.status === "rejected").length;

        if (failedDeleteCount > 0) {
            throw new Error(`Failed to delete ${failedDeleteCount} file(s)`);
        }

        await step.run({ name: "finalize-project-status" }, async () => Effect.runPromise(finalizeProjectStatus(input.graphId)));

        return {
            fileIds: input.fileIds,
        };
    } catch (error) {
        if (run.retryTerminal) {
            await step.run({ name: "mark-project-ready", retryPolicy: NO_RETRY }, async () =>
                Effect.runPromise(finalizeProjectStatus(input.graphId))
            );
        }

        throw workflowError(error);
    }
});
