import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import {
    memberTable,
    teamMemberRolesTable,
    teamMemberTable,
    userTable,
    type TeamMemberRole,
} from "@kiwi/db/tables/auth";
import type { TeamUserInput } from "@kiwi/contracts/teams";
import { forbiddenError, invalidTeamMembersError } from "@kiwi/contracts/errors";
import { and, asc, eq, inArray, sql } from "@kiwi/db/drizzle";

export function normalizeUsers({
    users,
    overrides = [],
}: {
    users: ReadonlyArray<TeamUserInput> | undefined;
    overrides?: ReadonlyArray<TeamUserInput>;
}) {
    const byUserId = new Map<string, TeamUserInput>();

    for (const user of users ?? []) {
        byUserId.set(user.user_id, user);
    }

    for (const user of overrides) {
        byUserId.set(user.user_id, user);
    }

    return [...byUserId.values()];
}

export function ensureTeamHasAdmin(users: ReadonlyArray<TeamUserInput>) {
    if (!users.some((teamUser) => teamUser.role === "admin")) {
        throw invalidTeamMembersError();
    }
}

export function ensureOrganizationMembers(organizationId: string, userIds: string[]) {
    return Effect.gen(function* () {
        if (userIds.length === 0) {
            return;
        }

        const rows = yield* tryDb((db) =>
            db
                .select({ userId: memberTable.userId })
                .from(memberTable)
                .where(and(eq(memberTable.organizationId, organizationId), inArray(memberTable.userId, userIds)))
        );
        const foundUserIds = new Set(rows.map((row) => row.userId));

        if (userIds.some((userId) => !foundUserIds.has(userId))) {
            return yield* Effect.fail(forbiddenError());
        }
    });
}

export function selectTeamUsers(teamId: string) {
    return Effect.gen(function* () {
        const role = sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`;

        const users = yield* tryDb((db) =>
            db
                .select({
                    team_id: teamMemberTable.teamId,
                    user_id: teamMemberTable.userId,
                    user_name: userTable.name,
                    role,
                    created_at: teamMemberTable.createdAt,
                    updated_at: teamMemberRolesTable.updatedAt,
                })
                .from(teamMemberTable)
                .innerJoin(userTable, eq(userTable.id, teamMemberTable.userId))
                .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                .where(eq(teamMemberTable.teamId, teamId))
                .orderBy(asc(userTable.name), asc(teamMemberTable.userId))
        );

        return users.map((user) => ({
            team_id: user.team_id,
            user_id: user.user_id,
            user_name: user.user_name,
            role: user.role,
            created_at: user.created_at?.toISOString() ?? null,
            updated_at: user.updated_at?.toISOString() ?? null,
        }));
    });
}
