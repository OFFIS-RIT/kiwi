import { defineWorkflowSpec } from "@kiwi/workflow";
import z from "zod";

export const processCodeFileSpec = defineWorkflowSpec({
    name: "process-code-file",
    version: "1.0.0",
    retryPolicy: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
        maximumAttempts: 3,
    },
    schema: z.object({
        graphId: z.string(),
        fileId: z.string(),
        codeManifestKey: z.string().optional(),
    }),
});
