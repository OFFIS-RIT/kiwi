import * as Effect from "effect/Effect";
import { roleIncludes } from "@kiwi/auth/permissions";
import { tryDb } from "@kiwi/db/effect";
import { teamMemberRolesTable, teamMemberTable, teamTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import type { TeamListItem } from "@kiwi/contracts/teams";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireOrganizationMembership } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

export function listTeams(input: { user: AuthUser }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationMembership(input.user);
            const organizationId = membership.organizationId;

            if (roleIncludes(membership.role, "admin")) {
                const teams = yield* tryDb((db) =>
                    db
                        .select({
                            team_id: teamTable.id,
                            team_name: teamTable.name,
                        })
                        .from(teamTable)
                        .where(eq(teamTable.organizationId, organizationId))
                        .orderBy(asc(teamTable.name))
                );

                return teams.map((team): TeamListItem => ({
                    ...team,
                    role: "admin",
                }));
            }

            const role = sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`;

            return yield* tryDb((db) =>
                db
                    .select({
                        team_id: teamTable.id,
                        team_name: teamTable.name,
                        role,
                    })
                    .from(teamMemberTable)
                    .innerJoin(teamTable, eq(teamTable.id, teamMemberTable.teamId))
                    .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                    .where(and(eq(teamTable.organizationId, organizationId), eq(teamMemberTable.userId, input.user.id)))
                    .orderBy(asc(teamTable.name))
            );
        }),
        toApiError
    );
}
