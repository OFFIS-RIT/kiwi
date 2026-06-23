import { defineWorkflow } from "openworkflow";
import { updateDescriptionsSpec } from "./update-descriptions-spec";
import { processDescriptionsGroupsSpec, DESCRIPTION_BATCHES_PER_GROUP } from "./process-descriptions-group-spec";
import { chunkItems } from "../lib/chunk";
import { DESCRIPTION_BATCH_SIZE } from "../lib/description-workflow";

export const processDescriptionsGroups = defineWorkflow(
    processDescriptionsGroupsSpec,
    async ({ input, step }) => {
        const entityIdBatches = chunkItems(input.entityIds, DESCRIPTION_BATCH_SIZE);
        const relationshipIdBatches = chunkItems(input.relationshipIds, DESCRIPTION_BATCH_SIZE);

        const allBatches = [
            ...entityIdBatches.map((entityIds) => ({ entityIds, relationshipIds: [] as string[] })),
            ...relationshipIdBatches.map((relationshipIds) => ({ entityIds: [] as string[], relationshipIds })),
        ];

        const batchesPerGroup = Math.min(DESCRIPTION_BATCHES_PER_GROUP, allBatches.length);
        const groupSize = Math.ceil(allBatches.length / batchesPerGroup);

        for (let i = 0; i < allBatches.length; i += groupSize) {
            const groupBatches = allBatches.slice(i, i + groupSize);
            const groupEntityIds = groupBatches.flatMap((b) => b.entityIds);
            const groupRelationshipIds = groupBatches.flatMap((b) => b.relationshipIds);

            if (groupEntityIds.length > 0 || groupRelationshipIds.length > 0) {
                await step.runWorkflow(updateDescriptionsSpec, {
                    graphId: input.graphId,
                    entityIds: groupEntityIds,
                    relationshipIds: groupRelationshipIds,
                });
            }
        }
    }
);