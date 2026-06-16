import { roleIncludes } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import { graphTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import type { GraphListItem } from "../../types/routes";
import { requireOrganizationMembership } from "../team/access";
import { mapGraphListItemsWithProcessing, selectGraphListFields } from "./route";

export async function listAccessibleGraphs(user: AuthUser): Promise<GraphListItem[]> {
    const membership = await requireOrganizationMembership(user);
    const organizationId = membership.organizationId;

    if (roleIncludes(membership.role, "admin")) {
        const graphs = await db
            .select(selectGraphListFields)
            .from(graphTable)
            .leftJoin(teamTable, eq(teamTable.id, graphTable.teamId))
            .where(
                and(
                    or(eq(graphTable.organizationId, organizationId), eq(graphTable.userId, user.id)),
                    isNull(graphTable.graphId),
                    eq(graphTable.hidden, false)
                )
            )
            .orderBy(asc(graphTable.teamId), asc(graphTable.name));

        return mapGraphListItemsWithProcessing(graphs, user.id);
    }

    const graphs = await db
        .select(selectGraphListFields)
        .from(graphTable)
        .leftJoin(teamTable, eq(teamTable.id, graphTable.teamId))
        .leftJoin(
            teamMemberTable,
            and(eq(teamMemberTable.teamId, graphTable.teamId), eq(teamMemberTable.userId, user.id))
        )
        .where(
            and(
                isNull(graphTable.graphId),
                eq(graphTable.hidden, false),
                or(
                    eq(graphTable.userId, user.id),
                    and(eq(graphTable.organizationId, organizationId), isNull(graphTable.teamId)),
                    and(eq(graphTable.organizationId, organizationId), eq(teamMemberTable.userId, user.id))
                )
            )
        )
        .orderBy(asc(graphTable.teamId), asc(graphTable.name));

    return mapGraphListItemsWithProcessing(graphs, user.id);
}
