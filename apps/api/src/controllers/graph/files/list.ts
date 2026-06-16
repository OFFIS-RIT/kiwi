import { db } from "@kiwi/db";
import { filesTable } from "@kiwi/db/tables/graph";
import type { GraphDetailFileRecord } from "@kiwi/contracts/graphs";
import { and, asc, eq } from "drizzle-orm";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { selectGraphDetailFileFields, toGraphFileRecord, type GraphFileRow } from "../../../lib/graph/route";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function listGraphFiles(input: { user: AuthUser; graphId: string }) {
    return tryApiPromise(async (): Promise<GraphDetailFileRecord[]> => {
        await assertCanViewGraph(input.user, input.graphId);

        const fileRows: GraphFileRow[] = await db
            .select(selectGraphDetailFileFields)
            .from(filesTable)
            .where(and(eq(filesTable.graphId, input.graphId), eq(filesTable.deleted, false)))
            .orderBy(asc(filesTable.createdAt), asc(filesTable.name));

        return fileRows.map(toGraphFileRecord);
    });
}
