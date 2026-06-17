import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { teamMemberRolesTable, teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import type { TeamCreateInput } from "@kiwi/contracts/teams";
import { internalServerError } from "@kiwi/contracts/errors";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, tryApiSync } from "../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers } from "./users/helpers";

export function createTeam(input: { user: AuthUser; body: TeamCreateInput }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationAdmin(input.user);
            const organizationId = membership.organizationId;
            const normalizedUsers = normalizeUsers({
                users: input.body.users,
                overrides: [{ user_id: input.user.id, role: "admin" }],
            });
            yield* tryApiSync(() => ensureTeamHasAdmin(normalizedUsers));
            yield* ensureOrganizationMembers(
                organizationId,
                normalizedUsers.map((teamUser) => teamUser.user_id)
            );

            return yield* tryDb((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
                        const [team] = yield* tx
                            .insert(teamTable)
                            .values({
                                name: input.body.name,
                                organizationId,
                            })
                            .returning({ id: teamTable.id });

                        if (!team) {
                            return yield* Effect.fail(internalServerError());
                        }

                        const roleByUserId = new Map(
                            normalizedUsers.map((teamUser) => [teamUser.user_id, teamUser.role])
                        );
                        const teamMembers =
                            normalizedUsers.length > 0
                                ? yield* tx
                                      .insert(teamMemberTable)
                                      .values(
                                          normalizedUsers.map((teamUser) => ({
                                              teamId: team.id,
                                              userId: teamUser.user_id,
                                          }))
                                      )
                                      .returning({
                                          id: teamMemberTable.id,
                                          teamId: teamMemberTable.teamId,
                                          userId: teamMemberTable.userId,
                                          createdAt: teamMemberTable.createdAt,
                                      })
                                : [];

                        if (teamMembers.length > 0) {
                            yield* tx.insert(teamMemberRolesTable).values(
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
                    })
                )
            );
        }),
        toApiError
    );
}
