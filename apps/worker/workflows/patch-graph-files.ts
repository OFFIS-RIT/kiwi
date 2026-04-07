import { defineWorkflow } from "openworkflow";
import { deleteFileSpec } from "./delete-file-spec";
import { patchGraphFilesSpec } from "./patch-graph-files-spec";
import { processFilesSpec } from "./process-files-spec";

export const patchGraphFiles = defineWorkflow(patchGraphFilesSpec, async ({ input, step }) => {
    for (const fileId of input.removedFileIds) {
        await step.runWorkflow(deleteFileSpec, {
            graphId: input.graphId,
            fileId,
        });
    }

    if (input.addedFileIds.length > 0) {
        await step.runWorkflow(processFilesSpec, {
            graphId: input.graphId,
            fileIds: input.addedFileIds,
        });
    }

    return {
        removedFileIds: input.removedFileIds,
        addedFileIds: input.addedFileIds,
    };
});
