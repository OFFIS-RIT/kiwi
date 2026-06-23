import { defineWorkflow } from "openworkflow";
import { updateDescriptionsSpec } from "./update-descriptions-spec";
import { processDescriptionsGroupsSpec } from "./process-descriptions-group-spec";
import { chunkItems } from "../lib/chunk";
import { DESCRIPTION_BATCH_SIZE } from "../lib/description-workflow";

/**
 * Spawns update-descriptions sub-workflows for a slice of entity/relationship IDs.
 * Each process-descriptions-group call handles at most DESCRIPTION_BATCHES_PER_GROUP
 * worth of IDs (pre-sliced by process-files), so this simply batches them for
 * update-descriptions without additional grouping.
 */
export const processDescriptionsGroups = defineWorkflow(
    processDescriptionsGroupsSpec,
    async ({ input, step }) => {
        const entityIdBatches = chunkItems(input.entityIds, DESCRIPTION_BATCH_SIZE);
        const relationshipIdBatches = chunkItems(input.relationshipIds, DESCRIPTION_BATCH_SIZE);

        const entityPromises = entityIdBatches.map((entityIds) =>
            step.runWorkflow(updateDescriptionsSpec, {
                graphId: input.graphId,
                entityIds,
                relationshipIds: [],
            })
        );

        const relationshipPromises = relationshipIdBatches.map((relationshipIds) =>
            step.runWorkflow(updateDescriptionsSpec, {
                graphId: input.graphId,
                entityIds: [],
                relationshipIds,
            })
        );

        const results = await Promise.allSettled([...entityPromises, ...relationshipPromises]);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
            throw new Error(`${failures.length} of ${results.length} description batches failed`);
        }
    }
);