import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import { teamMemberRolesTable, teamMemberTable, type TeamMemberRole } from "@kiwi/db/tables/auth";
import type { TeamUserListItem } from "@kiwi/contracts/teams";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { and, eq, sql } from "drizzle-orm";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";
import { ensureTeamHasAdmin, selectTeamUsers } from "./helpers";

export function removeTeamUser(input: { user: AuthUser; teamId: string; userId: string }) {
    return tryApiPromise(async (): Promise<TeamUserListItem[]> => {
        const access = await Effect.runPromise(requireTeamMemberManageAccess(input.user, input.teamId));

        await db.transaction(async (tx) => {
            const currentMembers = await tx
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
                throw new Error(API_ERROR_CODES.FORBIDDEN);
            }

            ensureTeamHasAdmin(currentMembers.filter((member) => member.user_id !== input.userId));

            await tx
                .delete(teamMemberTable)
                .where(and(eq(teamMemberTable.teamId, input.teamId), eq(teamMemberTable.userId, input.userId)));
        });

        return Effect.runPromise(selectTeamUsers(input.teamId));
    });
}
