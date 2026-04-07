import { defineWorkflowSpec } from "openworkflow";
import z from "zod";

export const deleteFileSpec = defineWorkflowSpec({
    name: "delete-file",
    version: "1.0.0",
    retryPolicy: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
    },
    schema: z.object({
        graphId: z.string(),
        fileId: z.string(),
    }),
});
