import { db } from "@kiwi/db";
import {
    memberTable,
    teamMemberRolesTable,
    teamMemberTable,
    userTable,
    type TeamMemberRole,
} from "@kiwi/db/tables/auth";
import type { TeamUserInput, TeamUserListItem } from "@kiwi/contracts/teams";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { tryApiPromise } from "../../_shared/api-effect";

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
        throw new Error(API_ERROR_CODES.INVALID_TEAM_MEMBERS);
    }
}

export function ensureOrganizationMembers(organizationId: string, userIds: string[]) {
    return tryApiPromise(async () => {
        if (userIds.length === 0) {
            return;
        }
    
        const rows = await db
            .select({ userId: memberTable.userId })
            .from(memberTable)
            .where(and(eq(memberTable.organizationId, organizationId), inArray(memberTable.userId, userIds)));
        const foundUserIds = new Set(rows.map((row) => row.userId));
    
        if (userIds.some((userId) => !foundUserIds.has(userId))) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }
    });
}

export function selectTeamUsers(teamId: string) {
    return tryApiPromise(async () => {
        const role = sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`;
    
        const users = await db
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
            .orderBy(asc(userTable.name), asc(teamMemberTable.userId));
    
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
