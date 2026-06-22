import * as Effect from "effect/Effect";
import { tryDbVoid } from "@kiwi/db/effect";
import { teamMemberRolesTable, teamMemberTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import { forbiddenError } from "@kiwi/contracts/errors";
import { and, eq, sql } from "@kiwi/db/drizzle";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError, tryApiSync } from "../../_shared/api-effect";
import { ensureTeamHasAdmin, selectTeamUsers } from "./helpers";

export function removeTeamUser(input: { user: AuthUser; teamId: string; userId: string }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const access = yield* requireTeamMemberManageAccess(input.user, input.teamId);

            yield* tryDbVoid((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
                        const currentMembers = yield* tx
                            .select({
                                user_id: teamMemberTable.userId,
                                role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                            })
                            .from(teamMemberTable)
                            .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                            .where(eq(teamMemberTable.teamId, input.teamId));
                        const existingMember = currentMembers.find((member) => member.user_id === input.userId);

                        if (!existingMember) {
                            return;
                        }

                        if (!access.organizationAdmin && existingMember.role === "admin") {
                            return yield* Effect.fail(forbiddenError());
                        }

                        yield* tryApiSync(() =>
                            ensureTeamHasAdmin(currentMembers.filter((member) => member.user_id !== input.userId))
                        );

                        yield* tx
                            .delete(teamMemberTable)
                            .where(
                                and(eq(teamMemberTable.teamId, input.teamId), eq(teamMemberTable.userId, input.userId))
                            );
                    })
                )
            );

            return yield* selectTeamUsers(input.teamId);
        }),
        toApiError
    );
}
