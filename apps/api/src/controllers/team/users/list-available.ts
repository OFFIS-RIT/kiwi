import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { memberTable, userTable } from "@kiwi/db/tables/auth";
import type { OrganizationMemberListItem } from "@kiwi/contracts/teams";
import { asc, eq } from "drizzle-orm";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function listAvailableUsers(input: { user: AuthUser; teamId: string }) {
    return tryApiPromise(async (): Promise<OrganizationMemberListItem[]> => {
        const access = await Effect.runPromise(requireTeamMemberManageAccess(input.user, input.teamId));

        return db
            .select({
                user_id: memberTable.userId,
                user_name: userTable.name,
                user_email: userTable.email,
                role: memberTable.role,
            })
            .from(memberTable)
            .innerJoin(userTable, eq(userTable.id, memberTable.userId))
            .where(eq(memberTable.organizationId, access.team.organizationId))
            .orderBy(asc(userTable.name), asc(userTable.email));
    });
}
