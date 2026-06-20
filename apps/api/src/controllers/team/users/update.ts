import * as Effect from "effect/Effect";
import { tryDbVoid } from "@kiwi/db/effect";
import { teamMemberRolesTable, teamMemberTable, teamTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import type { TeamUpdateUsersInput } from "@kiwi/contracts/teams";
import { forbiddenError } from "@kiwi/contracts/errors";
import { eq, sql } from "drizzle-orm";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError, tryApiSync } from "../../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers, selectTeamUsers } from "./helpers";

export function updateTeamUsers(input: { user: AuthUser; teamId: string; body: TeamUpdateUsersInput }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const access = yield* requireTeamMemberManageAccess(input.user, input.teamId);
            const normalizedUsers = normalizeUsers({ users: input.body.users });
            yield* ensureOrganizationMembers(
                access.team.organizationId,
                normalizedUsers.map((teamUser) => teamUser.user_id)
            );
            yield* tryApiSync(() => ensureTeamHasAdmin(normalizedUsers));

            yield* tryDbVoid((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx
                            .select({ id: teamTable.id })
                            .from(teamTable)
                            .where(eq(teamTable.id, input.teamId))
                            .for("update");

                        const currentMembers = yield* tx
                            .select({
                                user_id: teamMemberTable.userId,
                                role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                            })
                            .from(teamMemberTable)
                            .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                            .where(eq(teamMemberTable.teamId, input.teamId))
                            .for("update", { of: teamMemberTable });

                        if (!access.organizationAdmin) {
                            const currentAdminIds = new Set(
                                currentMembers
                                    .filter((member) => member.role === "admin")
                                    .map((member) => member.user_id)
                            );
                            const nextAdminIds = new Set(
                                normalizedUsers
                                    .filter((member) => member.role === "admin")
                                    .map((member) => member.user_id)
                            );

                            if (
                                currentAdminIds.size !== nextAdminIds.size ||
                                [...currentAdminIds].some((userId) => !nextAdminIds.has(userId))
                            ) {
                                return yield* Effect.fail(forbiddenError());
                            }
                        }

                        yield* tx.delete(teamMemberTable).where(eq(teamMemberTable.teamId, input.teamId));

                        if (normalizedUsers.length === 0) {
                            return;
                        }

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
                    })
                )
            );

            return yield* selectTeamUsers(input.teamId);
        }),
        toApiError
    );
}
