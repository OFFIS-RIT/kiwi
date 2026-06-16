import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import { teamMemberRolesTable, teamMemberTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import type { TeamAddUserInput, TeamUserListItem } from "@kiwi/contracts/teams";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { and, eq, sql } from "drizzle-orm";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers, selectTeamUsers } from "./helpers";

export function addTeamUser(input: { user: AuthUser; teamId: string; body: TeamAddUserInput }) {
    return tryApiPromise(async (): Promise<TeamUserListItem[]> => {
        const access = await requireTeamMemberManageAccess(input.user, input.teamId);
        const role = input.body.role ?? "member";
        await Effect.runPromise(ensureOrganizationMembers(access.team.organizationId, [input.body.user_id]));

        await db.transaction(async (tx) => {
            const [existingMember] = await tx
                .select({
                    user_id: teamMemberTable.userId,
                    role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                })
                .from(teamMemberTable)
                .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                .where(and(eq(teamMemberTable.teamId, input.teamId), eq(teamMemberTable.userId, input.body.user_id)))
                .limit(1);

            if (!access.organizationAdmin && (role === "admin" || existingMember?.role === "admin")) {
                throw new Error(API_ERROR_CODES.FORBIDDEN);
            }

            const currentMembers = await tx
                .select({
                    user_id: teamMemberTable.userId,
                    role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                })
                .from(teamMemberTable)
                .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                .where(eq(teamMemberTable.teamId, input.teamId));
            const nextMembers = normalizeUsers({
                users: currentMembers,
                overrides: [{ user_id: input.body.user_id, role }],
            });
            ensureTeamHasAdmin(nextMembers);

            const [teamMember] = await tx
                .insert(teamMemberTable)
                .values({
                    teamId: input.teamId,
                    userId: input.body.user_id,
                })
                .onConflictDoUpdate({
                    target: [teamMemberTable.teamId, teamMemberTable.userId],
                    set: {
                        teamId: input.teamId,
                    },
                })
                .returning({ id: teamMemberTable.id });

            if (!teamMember) {
                throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
            }

            await tx
                .insert(teamMemberRolesTable)
                .values({
                    teamMemberId: teamMember.id,
                    role,
                })
                .onConflictDoUpdate({
                    target: teamMemberRolesTable.teamMemberId,
                    set: {
                        role,
                    },
                });
        });

        return Effect.runPromise(selectTeamUsers(input.teamId));
    });
}
