import { roleIncludes } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { memberTable, teamTable } from "@kiwi/db/tables/auth";
import { and, eq } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth";
import { API_ERROR_CODES } from "../types";
import { getGraphById, resolveGraphOwnerRoot, type GraphRecord } from "./graph-access";
import { getOrganizationMembership, getTeamRole } from "./team-access";

type TeamRecord = {
    id: string;
    organizationId: string;
};

async function getTeamById(teamId: string): Promise<TeamRecord | null> {
    const [team] = await db
        .select({
            id: teamTable.id,
            organizationId: teamTable.organizationId,
        })
        .from(teamTable)
        .where(eq(teamTable.id, teamId))
        .limit(1);

    return team ?? null;
}

async function getOrganizationAccess(user: AuthUser, organizationId: string) {
    const membership = await getOrganizationMembership(user, organizationId);
    return {
        membership,
        admin: roleIncludes(membership?.role, "admin"),
    };
}

export async function assertCanManageUserPrompts(user: AuthUser, targetUserId: string) {
    if (targetUserId === user.id || user.isSystemAdmin) {
        return;
    }

    const membership = await getOrganizationMembership(user);
    if (!membership || !roleIncludes(membership.role, "admin")) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    const [targetMembership] = await db
        .select({ userId: memberTable.userId })
        .from(memberTable)
        .where(and(eq(memberTable.organizationId, membership.organizationId), eq(memberTable.userId, targetUserId)))
        .limit(1);

    if (!targetMembership) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

export async function assertCanManageTeamPrompts(user: AuthUser, teamId: string) {
    const team = await getTeamById(teamId);
    if (!team) {
        throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
    }

    if (user.isSystemAdmin) {
        return team;
    }

    const access = await getOrganizationAccess(user, team.organizationId);
    if (access.admin) {
        return team;
    }

    if (!access.membership) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    const teamRole = await getTeamRole(user.id, team.id);
    if (teamRole !== "admin") {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    return team;
}

export async function assertCanManageGraphPrompts(user: AuthUser, graphId: string): Promise<GraphRecord> {
    const graph = await getGraphById(graphId);
    if (!graph) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }

    if (user.isSystemAdmin) {
        return graph;
    }

    const rootOwner = await resolveGraphOwnerRoot(graph.id);
    if (rootOwner.mode === "user") {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    const access = await getOrganizationAccess(user, rootOwner.organizationId);
    if (access.admin) {
        return graph;
    }

    if (rootOwner.mode !== "team") {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    if (!access.membership) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    const teamRole = await getTeamRole(user.id, rootOwner.teamId);
    if (teamRole !== "admin") {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    return graph;
}
