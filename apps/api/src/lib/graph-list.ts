import { hasRole } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { graphTable, groupUserTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { GraphListItem } from "../types/routes";
import type { AuthUser } from "../middleware/auth";
import { mapGraphListItemsWithProcessing, selectGraphListFields } from "./graph-route";

export async function listAccessibleGraphs(user: AuthUser): Promise<GraphListItem[]> {
    if (hasRole(user.role, "admin")) {
        const graphs = await db
            .select(selectGraphListFields)
            .from(graphTable)
            .where(and(isNotNull(graphTable.groupId), isNull(graphTable.graphId), eq(graphTable.hidden, false)))
            .orderBy(asc(graphTable.groupId), asc(graphTable.name));

        return mapGraphListItemsWithProcessing(graphs);
    }

    const graphs = await db
        .select(selectGraphListFields)
        .from(graphTable)
        .innerJoin(groupUserTable, eq(groupUserTable.groupId, graphTable.groupId))
        .where(
            and(
                eq(groupUserTable.userId, user.id),
                isNotNull(graphTable.groupId),
                isNull(graphTable.graphId),
                eq(graphTable.hidden, false)
            )
        )
        .orderBy(asc(graphTable.groupId), asc(graphTable.name));

    return mapGraphListItemsWithProcessing(graphs);
}
