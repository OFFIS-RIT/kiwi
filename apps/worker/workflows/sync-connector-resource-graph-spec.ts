import { defineWorkflowSpec } from "@kiwi/workflow";
import z from "zod";

export const syncConnectorResourceGraphSpec = defineWorkflowSpec({
    name: "sync-connector-resource-graph",
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
        versionId: z.string().optional(),
        cursor: z.string().optional(),
        deliveryId: z.string().optional(),
    }),
});
