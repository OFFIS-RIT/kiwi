import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import { withWorkerDbVoid } from "../lib/runtime/effect";
import { eq, sql } from "@kiwi/db/drizzle";
import { defineWorkflow } from "@kiwi/workflow";
import { graphTable } from "@kiwi/db/tables/graph";
import { deleteFileSpec } from "./delete-file-spec";
import { deleteGraphFilesSpec } from "./delete-graph-files-spec";
import { runWorkerEffect } from "../lib/runtime/effect";

const NO_RETRY = { maximumAttempts: 1 } as const;

function finalizeProjectStatus(graphId: string): Effect.Effect<void, unknown, Database> {
    return withWorkerDbVoid((db) =>
        db.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx.execute(sql`
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

                yield* tx.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, graphId));
            })
        )
    );
}

export const deleteGraphFiles = defineWorkflow(deleteGraphFilesSpec, async ({ input, step, run }) => {
    try {
        await step.run({ name: "update-project-status" }, async () =>
            runWorkerEffect(
                withWorkerDbVoid((db) =>
                    db.update(graphTable).set({ state: "updating" }).where(eq(graphTable.id, input.graphId))
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

        await step.run({ name: "finalize-project-status" }, async () =>
            runWorkerEffect(finalizeProjectStatus(input.graphId))
        );

        return {
            fileIds: input.fileIds,
        };
    } catch (error) {
        if (run.retryTerminal) {
            await step.run({ name: "mark-project-ready", retryPolicy: NO_RETRY }, async () =>
                runWorkerEffect(finalizeProjectStatus(input.graphId))
            );
        }

        throw error;
    }
});
