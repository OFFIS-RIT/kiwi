import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { filesTable } from "@kiwi/db/tables/graph";
import { and, asc, eq } from "@kiwi/db/drizzle";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { selectGraphDetailFileFields, toGraphFileRecord, type GraphFileRow } from "../../../lib/graph/route";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function listGraphFiles(input: { user: AuthUser; graphId: string }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                yield* assertCanViewGraph(input.user, input.graphId);

                const fileRows: GraphFileRow[] = yield* tryDb((db) =>
                    db
                        .select(selectGraphDetailFileFields)
                        .from(filesTable)
                        .where(and(eq(filesTable.graphId, input.graphId), eq(filesTable.deleted, false)))
                        .orderBy(asc(filesTable.createdAt), asc(filesTable.name))
                );

                return fileRows.map(toGraphFileRecord);
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}
