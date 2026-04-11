import { db } from "@kiwi/db";
import { eq } from "drizzle-orm";
import { defineWorkflow } from "openworkflow";
import { graphTable } from "@kiwi/db/tables/graph";
import { deleteFileSpec } from "./delete-file-spec";
import { deleteGraphFilesSpec } from "./delete-graph-files-spec";

export const deleteGraphFiles = defineWorkflow(deleteGraphFilesSpec, async ({ input, step }) => {
    await step.run({ name: "update-project-status" }, async () => {
        await db.update(graphTable).set({ state: "updating" }).where(eq(graphTable.id, input.graphId));
    });

    try {
        for (const fileId of input.fileIds) {
            await step.runWorkflow(deleteFileSpec, {
                graphId: input.graphId,
                fileId,
            });
        }
    } finally {
        await step.run({ name: "finalize-project-status" }, async () => {
            await db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId));
        });
    }

    return {
        fileIds: input.fileIds,
    };
});
