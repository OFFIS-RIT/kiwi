import * as Effect from "effect/Effect";
import { tryDbVoid } from "@kiwi/db/effect";
import { teamMemberRolesTable, teamMemberTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import type { TeamAddUserInput } from "@kiwi/contracts/teams";
import { forbiddenError, internalServerError } from "@kiwi/contracts/errors";
import { and, eq, sql } from "drizzle-orm";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError, tryApiSync } from "../../_shared/api-effect";
import { ensureOrganizationMembers, ensureTeamHasAdmin, normalizeUsers, selectTeamUsers } from "./helpers";

export function addTeamUser(input: { user: AuthUser; teamId: string; body: TeamAddUserInput }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const access = yield* requireTeamMemberManageAccess(input.user, input.teamId);
            const role = input.body.role ?? "member";
            yield* ensureOrganizationMembers(access.team.organizationId, [input.body.user_id]);

            yield* tryDbVoid((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
                        const [existingMember] = yield* tx
                            .select({
                                user_id: teamMemberTable.userId,
                                role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                            })
                            .from(teamMemberTable)
                            .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                            .where(
                                and(eq(teamMemberTable.teamId, input.teamId), eq(teamMemberTable.userId, input.body.user_id))
                            )
                            .limit(1);

                        if (!access.organizationAdmin && (role === "admin" || existingMember?.role === "admin")) {
                            return yield* Effect.fail(forbiddenError());
                        }

                        const currentMembers = yield* tx
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
                        yield* tryApiSync(() => ensureTeamHasAdmin(nextMembers));

                        const [teamMember] = yield* tx
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
                            return yield* Effect.fail(internalServerError());
                        }

                        yield* tx
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
                    })
                )
            );

            return yield* selectTeamUsers(input.teamId);
        }),
        toApiError
    );
}
