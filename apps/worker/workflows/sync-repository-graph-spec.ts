import { defineWorkflowSpec } from "openworkflow";
import z from "zod";

export const syncRepositoryGraphSpec = defineWorkflowSpec({
    name: "sync-repository-graph",
    version: "1.0.0",
    retryPolicy: {
        initialInterval: "5s",
        backoffCoefficient: 2,
        maximumInterval: "1m",
        maximumAttempts: 3,
    },
    schema: z.object({
        bindingId: z.string(),
        reason: z.enum(["initial", "webhook", "manual"]),
        commitSha: z.string().optional(),
        deliveryId: z.string().optional(),
    }),
});
