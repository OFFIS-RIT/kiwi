import { defineWorkflowSpec } from "@kiwi/workflow";
import z from "zod";

/**
 * Maximum number of update-descriptions sub-workflow calls per group.
 * Keep this low enough that the group workflow itself stays well under
 * the WorkflowClient step limit (1000), while ensuring the number of groups
 * spawned by process-files also stays bounded.
 */
export const DESCRIPTION_BATCHES_PER_GROUP = 50;

export const processDescriptionsGroupsSpec = defineWorkflowSpec({
    name: "process-descriptions-groups",
    version: "1.0.0",
    retryPolicy: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
        maximumAttempts: 3,
    },
    schema: z.object({
        graphId: z.string(),
        entityIds: z.array(z.string()),
        relationshipIds: z.array(z.string()),
    }),
});
