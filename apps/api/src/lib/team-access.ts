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
import type { AuthUser } from "../middleware/auth";
import { API_ERROR_CODES } from "../types";

export type TeamRole = TeamMemberRole;

export async function getActiveOrganizationId(user: AuthUser) {
    if (user.activeOrganizationId) {
        return user.activeOrganizationId;
    }

    return getDefaultOrganizationId();
}

async function organizationExists(organizationId: string) {
    const [organization] = await db
        .select({ id: organizationTable.id })
        .from(organizationTable)
        .where(eq(organizationTable.id, organizationId))
        .limit(1);

    return Boolean(organization);
}

export async function getOrganizationMembership(user: AuthUser, organizationId?: string) {
    const activeOrganizationId = organizationId ?? (await getActiveOrganizationId(user));
    const [membership] = await db
        .select({
            organizationId: memberTable.organizationId,
            userId: memberTable.userId,
            role: memberTable.role,
        })
        .from(memberTable)
        .where(and(eq(memberTable.organizationId, activeOrganizationId), eq(memberTable.userId, user.id)))
        .limit(1);

    if (membership) {
        return membership;
    }

    if (user.isSystemAdmin && (await organizationExists(activeOrganizationId))) {
        return {
            organizationId: activeOrganizationId,
            userId: user.id,
            role: "admin",
        };
    }

    return null;
}

export async function requireOrganizationMembership(user: AuthUser, organizationId?: string) {
    const membership = await getOrganizationMembership(user, organizationId);
    if (!membership) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    return membership;
}

export async function requireOrganizationAdmin(user: AuthUser, organizationId?: string) {
    const membership = await getOrganizationMembership(user, organizationId);
    if (!membership || !roleIncludes(membership.role, "admin")) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    return membership;
}

export async function getTeamRole(userId: string, teamId: string): Promise<TeamRole | null> {
    const [membership] = await db
        .select({
            role: sql<TeamRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
        })
        .from(teamMemberTable)
        .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
        .where(and(eq(teamMemberTable.teamId, teamId), eq(teamMemberTable.userId, userId)))
        .limit(1);

    return membership?.role ?? null;
}

export async function getTeamInActiveOrganization(user: AuthUser, teamId: string) {
    const organizationId = await getActiveOrganizationId(user);
    const [team] = await db
        .select({
            id: teamTable.id,
            name: teamTable.name,
            organizationId: teamTable.organizationId,
        })
        .from(teamTable)
        .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, organizationId)))
        .limit(1);

    return team ?? null;
}

export async function requireTeamAccess(user: AuthUser, teamId: string) {
    const team = await getTeamInActiveOrganization(user, teamId);
    if (!team) {
        throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
    }

    const organizationMembership = await getOrganizationMembership(user, team.organizationId);
    if (roleIncludes(organizationMembership?.role, "admin")) {
        return {
            team,
            role: "admin" as const,
            organizationAdmin: true,
        };
    }

    if (!organizationMembership) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    const role = await getTeamRole(user.id, teamId);
    if (!role) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    return {
        team,
        role,
        organizationAdmin: false,
    };
}

export async function requireTeamGraphCreateAccess(user: AuthUser, teamId: string) {
    const access = await requireTeamAccess(user, teamId);
    if (access.organizationAdmin || access.role === "admin") {
        return access;
    }

    throw new Error(API_ERROR_CODES.FORBIDDEN);
}

export async function requireTeamGraphFileManageAccess(user: AuthUser, teamId: string) {
    const access = await requireTeamAccess(user, teamId);
    if (access.organizationAdmin || access.role === "admin" || access.role === "moderator") {
        return access;
    }

    throw new Error(API_ERROR_CODES.FORBIDDEN);
}

export async function requireTeamMemberManageAccess(user: AuthUser, teamId: string) {
    const access = await requireTeamAccess(user, teamId);
    if (access.organizationAdmin || access.role === "admin") {
        return access;
    }

    throw new Error(API_ERROR_CODES.FORBIDDEN);
}
