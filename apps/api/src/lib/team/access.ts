import * as Effect from "effect/Effect";
import { getDefaultOrganizationId } from "@kiwi/auth/server";
import { roleIncludes } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import {
    memberTable,
    organizationTable,
    teamMemberRolesTable,
    teamMemberTable,
    teamTable,
    type TeamMemberRole,
} from "@kiwi/db/tables/auth";
import { and, eq, sql } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { API_ERROR_CODES } from "../../types";

export type TeamRole = TeamMemberRole;

export function getActiveOrganizationId(user: AuthUser): Effect.Effect<string, unknown> {
    if (user.activeOrganizationId) {
        return Effect.succeed(user.activeOrganizationId);
    }

    return getDefaultOrganizationId();
}

function organizationExists(organizationId: string): Effect.Effect<boolean, unknown> {
    return Effect.tryPromise(async () => {
        const [organization] = await db
            .select({ id: organizationTable.id })
            .from(organizationTable)
            .where(eq(organizationTable.id, organizationId))
            .limit(1);

        return Boolean(organization);
    });
}

export function getOrganizationMembership(user: AuthUser, organizationId?: string) {
    return Effect.gen(function* () {
        const activeOrganizationId = organizationId ?? (yield* getActiveOrganizationId(user));
        const [membership] = yield* Effect.tryPromise(() =>
            db
                .select({
                    organizationId: memberTable.organizationId,
                    userId: memberTable.userId,
                    role: memberTable.role,
                })
                .from(memberTable)
                .where(and(eq(memberTable.organizationId, activeOrganizationId), eq(memberTable.userId, user.id)))
                .limit(1)
        );

        if (user.isSystemAdmin && (membership || (yield* organizationExists(activeOrganizationId)))) {
            return {
                organizationId: activeOrganizationId,
                userId: user.id,
                role: "admin",
            };
        }

        if (membership) {
            return membership;
        }

        return null;
    });
}

export function requireOrganizationMembership(user: AuthUser, organizationId?: string) {
    return Effect.gen(function* () {
        const membership = yield* getOrganizationMembership(user, organizationId);
        if (!membership) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        return membership;
    });
}

export function requireOrganizationAdmin(user: AuthUser, organizationId?: string) {
    return Effect.gen(function* () {
        const membership = yield* getOrganizationMembership(user, organizationId);
        if (!membership || !roleIncludes(membership.role, "admin")) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        return membership;
    });
}

export function getTeamRole(userId: string, teamId: string): Effect.Effect<TeamRole | null, unknown> {
    return Effect.tryPromise(async () => {
        const [membership] = await db
            .select({
                role: sql<TeamRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
            })
            .from(teamMemberTable)
            .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
            .where(and(eq(teamMemberTable.teamId, teamId), eq(teamMemberTable.userId, userId)))
            .limit(1);

        return membership?.role ?? null;
    });
}

export function getTeamInActiveOrganization(user: AuthUser, teamId: string) {
    return Effect.gen(function* () {
        const organizationId = yield* getActiveOrganizationId(user);
        const [team] = yield* Effect.tryPromise(() =>
            db
                .select({
                    id: teamTable.id,
                    name: teamTable.name,
                    organizationId: teamTable.organizationId,
                })
                .from(teamTable)
                .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, organizationId)))
                .limit(1)
        );

        return team ?? null;
    });
}

export function requireTeamAccess(user: AuthUser, teamId: string) {
    return Effect.gen(function* () {
        const team = yield* getTeamInActiveOrganization(user, teamId);
        if (!team) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.TEAM_NOT_FOUND));
        }

        const organizationMembership = yield* getOrganizationMembership(user, team.organizationId);
        if (roleIncludes(organizationMembership?.role, "admin")) {
            return {
                team,
                role: "admin" as const,
                organizationAdmin: true,
            };
        }

        if (!organizationMembership) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        const role = yield* getTeamRole(user.id, teamId);
        if (!role) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        return {
            team,
            role,
            organizationAdmin: false,
        };
    });
}

export function requireTeamGraphCreateAccess(user: AuthUser, teamId: string) {
    return Effect.gen(function* () {
        const access = yield* requireTeamAccess(user, teamId);
        if (access.organizationAdmin || access.role === "admin" || access.role === "moderator") {
            return access;
        }

        return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
    });
}

export function requireTeamGraphFileManageAccess(user: AuthUser, teamId: string) {
    return Effect.gen(function* () {
        const access = yield* requireTeamAccess(user, teamId);
        if (access.organizationAdmin || access.role === "admin" || access.role === "moderator") {
            return access;
        }

        return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
    });
}

export function requireTeamMemberManageAccess(user: AuthUser, teamId: string) {
    return Effect.gen(function* () {
        const access = yield* requireTeamAccess(user, teamId);
        if (access.organizationAdmin || access.role === "admin") {
            return access;
        }

        return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
    });
}
