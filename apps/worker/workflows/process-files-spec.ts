import { defineWorkflowSpec } from "openworkflow";
import z from "zod";

export const processFilesSpec = defineWorkflowSpec({
    name: "process-files",
    version: "1.0.0",
    retryPolicy: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
        maximumAttempts: 3,
    },
    schema: z.object({
        graphId: z.string(),
        fileIds: z.array(z.string()),
        processRunId: z.string().optional(),
    }),
});
