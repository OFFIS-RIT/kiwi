import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { teamMemberRolesTable, teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import type { TeamCreateInput, TeamCreateSuccessData } from "@kiwi/contracts/teams";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers } from "./users/helpers";

export function createTeam(input: { user: AuthUser; body: TeamCreateInput }) {
    return tryApiPromise(async (): Promise<TeamCreateSuccessData> => {
        const membership = await Effect.runPromise(requireOrganizationAdmin(input.user));
        const organizationId = membership.organizationId;
        const normalizedUsers = normalizeUsers({
            users: input.body.users,
            overrides: [{ user_id: input.user.id, role: "admin" }],
        });
        ensureTeamHasAdmin(normalizedUsers);
        await ensureOrganizationMembers(
            organizationId,
            normalizedUsers.map((teamUser) => teamUser.user_id)
        );

        return db.transaction(async (tx) => {
            const [team] = await tx
                .insert(teamTable)
                .values({
                    name: input.body.name,
                    organizationId,
                })
                .returning({ id: teamTable.id });

            if (!team) {
                throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
            }

            const roleByUserId = new Map(normalizedUsers.map((teamUser) => [teamUser.user_id, teamUser.role]));
            const teamMembers =
                normalizedUsers.length > 0
                    ? await tx
                          .insert(teamMemberTable)
                          .values(normalizedUsers.map((teamUser) => ({ teamId: team.id, userId: teamUser.user_id })))
                          .returning({
                              id: teamMemberTable.id,
                              teamId: teamMemberTable.teamId,
                              userId: teamMemberTable.userId,
                              createdAt: teamMemberTable.createdAt,
                          })
                    : [];

            if (teamMembers.length > 0) {
                await tx.insert(teamMemberRolesTable).values(
                    teamMembers.map((teamMember) => ({
                        teamMemberId: teamMember.id,
                        role: roleByUserId.get(teamMember.userId) ?? "member",
                    }))
                );
            }

            return {
                team,
                users: teamMembers.map((teamMember) => ({
                    teamId: teamMember.teamId,
                    userId: teamMember.userId,
                    role: roleByUserId.get(teamMember.userId) ?? "member",
                    createdAt: teamMember.createdAt,
                    updatedAt: null,
                })),
            };
        });
    });
}
