import { runWorkerEffect } from "../lib/runtime/effect";
import { defineWorkflow } from "@kiwi/workflow";
import { regenerateEntities, regenerateRelationships } from "../lib/descriptions/regenerate";
import { updateDescriptionsSpec } from "./update-descriptions-spec";

export const updateDescriptions = defineWorkflow(updateDescriptionsSpec, async ({ input, step }) => {
    if (input.entityIds.length > 0) {
        await step.run({ name: "regenerate-entities" }, async () =>
            runWorkerEffect(regenerateEntities(input.graphId, input.entityIds))
        );
    }

    if (input.relationshipIds.length > 0) {
        await step.run({ name: "regenerate-relationships" }, async () =>
            runWorkerEffect(regenerateRelationships(input.graphId, input.relationshipIds))
        );
    }
});
