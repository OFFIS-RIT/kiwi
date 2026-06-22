import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { teamMemberRolesTable, teamMemberTable, teamTable } from "@kiwi/db/tables/auth";
import type { TeamPatchInput } from "@kiwi/contracts/teams";
import { teamNotFoundError } from "@kiwi/contracts/errors";
import { and, eq } from "@kiwi/db/drizzle";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, tryApiSync } from "../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers, selectTeamUsers } from "./users/helpers";

export function patchTeam(input: { user: AuthUser; teamId: string; body: TeamPatchInput }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationAdmin(input.user);
            const organizationId = membership.organizationId;

            const normalizedUsers = input.body.users ? normalizeUsers({ users: input.body.users }) : undefined;
            if (normalizedUsers) {
                yield* tryApiSync(() => ensureTeamHasAdmin(normalizedUsers));
                yield* ensureOrganizationMembers(
                    organizationId,
                    normalizedUsers.map((teamUser) => teamUser.user_id)
                );
            }

            const team = yield* tryDb((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
                        const [existingTeam] = yield* tx
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
                            return yield* Effect.fail(teamNotFoundError());
                        }

                        const [team] =
                            input.body.name !== undefined
                                ? yield* tx
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
                            yield* tx.delete(teamMemberTable).where(eq(teamMemberTable.teamId, input.teamId));

                            if (normalizedUsers.length > 0) {
                                const roleByUserId = new Map(
                                    normalizedUsers.map((teamUser) => [teamUser.user_id, teamUser.role])
                                );
                                const teamMembers = yield* tx
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

                                yield* tx.insert(teamMemberRolesTable).values(
                                    teamMembers.map((teamMember) => ({
                                        teamMemberId: teamMember.id,
                                        role: roleByUserId.get(teamMember.userId) ?? "member",
                                    }))
                                );
                            }
                        }

                        return team ?? existingTeam;
                    })
                )
            );
            const users = yield* selectTeamUsers(input.teamId);

            return { team, users };
        }),
        toApiError
    );
}
