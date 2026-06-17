import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { memberTable, userTable } from "@kiwi/db/tables/auth";
import { asc, eq } from "drizzle-orm";
import { requireTeamMemberManageAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function listAvailableUsers(input: { user: AuthUser; teamId: string }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const access = yield* requireTeamMemberManageAccess(input.user, input.teamId);

            return yield* tryDb((db) =>
                db
                    .select({
                        user_id: memberTable.userId,
                        user_name: userTable.name,
                        user_email: userTable.email,
                        role: memberTable.role,
                    })
                    .from(memberTable)
                    .innerJoin(userTable, eq(userTable.id, memberTable.userId))
                    .where(eq(memberTable.organizationId, access.team.organizationId))
                    .orderBy(asc(userTable.name), asc(userTable.email))
            );
        }),
        toApiError
    );
}
