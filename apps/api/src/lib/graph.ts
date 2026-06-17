import { DatabaseError, type EffectDatabase } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";
import { graphTable } from "@kiwi/db/tables/graph";
import { inArray } from "drizzle-orm";

type GraphQueryRunner = {
    select: EffectDatabase["select"];
};

export function collectGraphClosure(
    queryRunner: GraphQueryRunner,
    rootGraphIds: string[]
): Effect.Effect<string[], DatabaseError> {
    return Effect.gen(function* () {
        if (rootGraphIds.length === 0) {
            return [];
        }

        const graphIds = new Set(rootGraphIds);
        let frontier = [...graphIds];

        while (frontier.length > 0) {
            const childRows = yield* queryRunner
                .select({ id: graphTable.id })
                .from(graphTable)
                .where(inArray(graphTable.graphId, frontier))
                .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));

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
