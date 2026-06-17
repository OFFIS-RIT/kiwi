import { roleIncludes } from "@kiwi/auth/permissions";
import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import { graphTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import type { GraphListItem } from "../../types/routes";
import { requireOrganizationMembership } from "../team/access";
import { mapGraphListItemsWithProcessing, selectGraphListFields } from "./route";


export function listAccessibleGraphs(user: AuthUser): Effect.Effect<GraphListItem[], unknown, Database> {
    return Effect.gen(function* () {
        const membership = yield* requireOrganizationMembership(user);
        const organizationId = membership.organizationId;
    
        if (roleIncludes(membership.role, "admin")) {
            const graphs = yield* tryDb((db) => db
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
                .orderBy(asc(graphTable.teamId), asc(graphTable.name))
            );
            return yield* mapGraphListItemsWithProcessing(graphs, user.id);
        }
    
        const graphs = yield* tryDb((db) => db
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
            .orderBy(asc(graphTable.teamId), asc(graphTable.name))
        );
        return yield* mapGraphListItemsWithProcessing(graphs, user.id);
    });
}
