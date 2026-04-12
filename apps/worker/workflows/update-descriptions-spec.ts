import { defineWorkflowSpec } from "openworkflow";
import z from "zod";

export const updateDescriptionsSpec = defineWorkflowSpec({
    name: "update-descriptions",
    version: "1.0.0",
    retryPolicy: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
    },
    schema: z.object({
        graphId: z.string(),
        entityIds: z.array(z.string()).default([]),
        relationshipIds: z.array(z.string()).default([]),
    }),
});
