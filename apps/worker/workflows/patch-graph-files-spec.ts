import { defineWorkflowSpec } from "openworkflow";
import z from "zod";

export const patchGraphFilesSpec = defineWorkflowSpec({
    name: "patch-graph-files",
    version: "1.0.0",
    retryPolicy: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
    },
    schema: z.object({
        graphId: z.string(),
        removedFileIds: z.array(z.string()),
        addedFileIds: z.array(z.string()),
    }),
});
