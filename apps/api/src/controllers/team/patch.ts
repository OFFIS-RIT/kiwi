import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import { teamMemberRolesTable, teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import type { TeamPatchInput, TeamPatchSuccessData } from "@kiwi/contracts/teams";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { and, eq } from "drizzle-orm";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers, selectTeamUsers } from "./users/helpers";

export function patchTeam(input: { user: AuthUser; teamId: string; body: TeamPatchInput }) {
    return tryApiPromise(async (): Promise<TeamPatchSuccessData> => {
        const membership = await Effect.runPromise(requireOrganizationAdmin(input.user));
        const organizationId = membership.organizationId;

        const normalizedUsers = input.body.users ? normalizeUsers({ users: input.body.users }) : undefined;
        if (normalizedUsers) {
            ensureTeamHasAdmin(normalizedUsers);
            await Effect.runPromise(
                ensureOrganizationMembers(
                    organizationId,
                    normalizedUsers.map((teamUser) => teamUser.user_id)
                )
            );
        }

        const team = await db.transaction(async (tx) => {
            const [existingTeam] = await tx
                .select({
                    id: teamTable.id,
                    name: teamTable.name,
                    organizationId: teamTable.organizationId,
                    createdAt: teamTable.createdAt,
                    updatedAt: teamTable.updatedAt,
                })
                .from(teamTable)
                .where(and(eq(teamTable.id, input.teamId), eq(teamTable.organizationId, organizationId)))
                .limit(1);

            if (!existingTeam) {
                throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
            }

            const [team] =
                input.body.name !== undefined
                    ? await tx
                          .update(teamTable)
                          .set({ name: input.body.name })
                          .where(eq(teamTable.id, input.teamId))
                          .returning({
                              id: teamTable.id,
                              name: teamTable.name,
                              organizationId: teamTable.organizationId,
                              createdAt: teamTable.createdAt,
                              updatedAt: teamTable.updatedAt,
                          })
                    : [existingTeam];

            if (normalizedUsers !== undefined) {
                await tx.delete(teamMemberTable).where(eq(teamMemberTable.teamId, input.teamId));

                if (normalizedUsers.length > 0) {
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
                }
            }

            return team ?? existingTeam;
        });

        return {
            team,
            users: await Effect.runPromise(selectTeamUsers(input.teamId)),
        };
    });
}
