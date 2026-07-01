import { defineWorkflow } from "@kiwi/workflow";
import { updateDescriptionsSpec } from "./update-descriptions-spec";
import { processDescriptionsGroupsSpec } from "./process-descriptions-group-spec";
import { chunkItems } from "../lib/collections/chunk";
import { DESCRIPTION_BATCH_SIZE } from "../lib/descriptions/workflow";

const DESCRIPTION_CHILD_WORKFLOW_CONCURRENCY = 4;

export async function allSettledWithConcurrency<T, TResult>(
    items: T[],
    concurrency: number,
    run: (item: T, index: number) => Promise<TResult>
): Promise<PromiseSettledResult<TResult>[]> {
    const results = new Array<PromiseSettledResult<TResult>>(items.length);
    let nextIndex = 0;
    const safeConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
    const workerCount = Math.min(items.length, safeConcurrency);

    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                try {
                    results[index] = { status: "fulfilled", value: await run(items[index]!, index) };
                } catch (reason) {
                    results[index] = { status: "rejected", reason };
                }
            }
        })
    );

    return results;
}

/**
 * Spawns update-descriptions sub-workflows for a slice of entity/relationship IDs.
 * Each process-descriptions-group call handles at most DESCRIPTION_BATCHES_PER_GROUP
 * worth of IDs (pre-sliced by process-files), so this simply batches them for
 * update-descriptions without additional grouping.
 */
export const processDescriptionsGroups = defineWorkflow(processDescriptionsGroupsSpec, async ({ input, step }) => {
    const entityIdBatches = chunkItems(input.entityIds, DESCRIPTION_BATCH_SIZE);
    const relationshipIdBatches = chunkItems(input.relationshipIds, DESCRIPTION_BATCH_SIZE);

    const batches = [
        ...entityIdBatches.map((entityIds) => ({ entityIds, relationshipIds: [] as string[] })),
        ...relationshipIdBatches.map((relationshipIds) => ({ entityIds: [] as string[], relationshipIds })),
    ];

    const results = await allSettledWithConcurrency(
        batches,
        DESCRIPTION_CHILD_WORKFLOW_CONCURRENCY,
        ({ entityIds, relationshipIds }) =>
            step.runWorkflow(updateDescriptionsSpec, {
                graphId: input.graphId,
                entityIds,
                relationshipIds,
            })
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        throw new Error(`${failures.length} of ${results.length} description batches failed`);
    }
});
