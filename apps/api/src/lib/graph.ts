import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import { graphTable } from "@kiwi/db/tables/graph";
import { inArray } from "drizzle-orm";

function tryUnknownPromise<T>(thunk: () => PromiseLike<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({ try: thunk, catch: (error) => error });
}

type GraphQueryRunner = {
    select: typeof db.select;
};

export function collectGraphClosure(
    queryRunner: GraphQueryRunner,
    rootGraphIds: string[]
): Effect.Effect<string[], unknown> {
    return tryUnknownPromise(async () => {
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
    });
}
