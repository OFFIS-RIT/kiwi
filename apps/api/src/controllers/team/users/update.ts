import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import { teamMemberRolesTable, teamMemberTable, teamTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import type { TeamUpdateUsersInput, TeamUserListItem } from "@kiwi/contracts/teams";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { eq, sql } from "drizzle-orm";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers, selectTeamUsers } from "./helpers";

export function updateTeamUsers(input: { user: AuthUser; teamId: string; body: TeamUpdateUsersInput }) {
    return tryApiPromise(async (): Promise<TeamUserListItem[]> => {
        const access = await Effect.runPromise(requireTeamMemberManageAccess(input.user, input.teamId));
        const normalizedUsers = normalizeUsers({ users: input.body.users });
        await Effect.runPromise(
            ensureOrganizationMembers(
                access.team.organizationId,
                normalizedUsers.map((teamUser) => teamUser.user_id)
            )
        );

        await db.transaction(async (tx) => {
            await tx.select({ id: teamTable.id }).from(teamTable).where(eq(teamTable.id, input.teamId)).for("update");

            const currentMembers = await tx
                .select({
                    user_id: teamMemberTable.userId,
                    role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                })
                .from(teamMemberTable)
                .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                .where(eq(teamMemberTable.teamId, input.teamId))
                .for("update", { of: teamMemberTable });

            ensureTeamHasAdmin(normalizedUsers);

            if (!access.organizationAdmin) {
                const currentAdminIds = new Set(
                    currentMembers.filter((member) => member.role === "admin").map((member) => member.user_id)
                );
                const nextAdminIds = new Set(
                    normalizedUsers.filter((member) => member.role === "admin").map((member) => member.user_id)
                );

                if (
                    currentAdminIds.size !== nextAdminIds.size ||
                    [...currentAdminIds].some((userId) => !nextAdminIds.has(userId))
                ) {
                    throw new Error(API_ERROR_CODES.FORBIDDEN);
                }
            }

            await tx.delete(teamMemberTable).where(eq(teamMemberTable.teamId, input.teamId));

            if (normalizedUsers.length === 0) {
                return;
            }

            const roleByUserId = new Map(normalizedUsers.map((teamUser) => [teamUser.user_id, teamUser.role]));
            const teamMembers = await tx
                .insert(teamMemberTable)
                .values(
                    normalizedUsers.map((teamUser) => ({
                        teamId: input.teamId,
                        userId: teamUser.user_id,
                    }))
                )
                .returning({
                    id: teamMemberTable.id,
                    userId: teamMemberTable.userId,
                });

            await tx.insert(teamMemberRolesTable).values(
                teamMembers.map((teamMember) => ({
                    teamMemberId: teamMember.id,
                    role: roleByUserId.get(teamMember.userId) ?? "member",
                }))
            );
        });

        return Effect.runPromise(selectTeamUsers(input.teamId));
    });
}
