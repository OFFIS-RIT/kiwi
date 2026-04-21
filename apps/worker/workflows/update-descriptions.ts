import { defineWorkflow } from "openworkflow";
import { regenerateEntities, regenerateRelationships } from "../lib/regenerate-descriptions";
import { updateDescriptionsSpec } from "./update-descriptions-spec";

export const updateDescriptions = defineWorkflow(updateDescriptionsSpec, async ({ input, step }) => {
    if (input.entityIds.length > 0) {
        await step.run({ name: "regenerate-entities" }, async () => {
            await regenerateEntities(input.graphId, input.entityIds);
        });
    }

    if (input.relationshipIds.length > 0) {
        await step.run({ name: "regenerate-relationships" }, async () => {
            await regenerateRelationships(input.graphId, input.relationshipIds);
        });
    }
});
