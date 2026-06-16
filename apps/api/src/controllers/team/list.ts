import { roleIncludes } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { teamMemberRolesTable, teamMemberTable, teamTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import type { TeamListItem } from "@kiwi/contracts/teams";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireOrganizationMembership } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

export function listTeams(input: { user: AuthUser }) {
    return tryApiPromise(async (): Promise<TeamListItem[]> => {
        const membership = await requireOrganizationMembership(input.user);
        const organizationId = membership.organizationId;

        if (roleIncludes(membership.role, "admin")) {
            const teams = await db
                .select({
                    team_id: teamTable.id,
                    team_name: teamTable.name,
                })
                .from(teamTable)
                .where(eq(teamTable.organizationId, organizationId))
                .orderBy(asc(teamTable.name));

            return teams.map((team) => ({
                ...team,
                role: "admin" as const,
            }));
        }

        const role = sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`;

        return db
            .select({
                team_id: teamTable.id,
                team_name: teamTable.name,
                role,
            })
            .from(teamMemberTable)
            .innerJoin(teamTable, eq(teamTable.id, teamMemberTable.teamId))
            .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
            .where(and(eq(teamTable.organizationId, organizationId), eq(teamMemberTable.userId, input.user.id)))
            .orderBy(asc(teamTable.name));
    });
}
