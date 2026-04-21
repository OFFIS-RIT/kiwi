import { db } from "@kiwi/db";
import { graphTable } from "@kiwi/db/tables/graph";
import { inArray } from "drizzle-orm";

type GraphQueryRunner = {
    select: typeof db.select;
};

export async function collectGraphClosure(queryRunner: GraphQueryRunner, rootGraphIds: string[]): Promise<string[]> {
    if (rootGraphIds.length === 0) {
        return [];
    }

    const graphIds = new Set(rootGraphIds);
    let frontier = [...graphIds];

    while (frontier.length > 0) {
        const childRows = await queryRunner
            .select({ id: graphTable.id })
            .from(graphTable)
            .where(inArray(graphTable.graphId, frontier));

        const nextFrontier: string[] = [];
        for (const child of childRows) {
            if (graphIds.has(child.id)) {
                continue;
            }

            graphIds.add(child.id);
            nextFrontier.push(child.id);
        }

        frontier = nextFrontier;
    }

    return [...graphIds];
}
