import { auth } from "@kiwi/auth/server";
import { hasRole, type KiwiPermissions } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { graphTable, groupTable, groupUserTable } from "@kiwi/db/tables/graph";
import { and, eq } from "drizzle-orm";
import { getAuthHeaders, type AuthUser } from "../middleware/auth";
import { API_ERROR_CODES } from "../types";
import type { GraphRecord } from "../types/routes";

export type { GraphRecord } from "../types/routes";

export type RootOwner =
    | {
          mode: "user";
          userId: string;
      }
    | {
          mode: "group";
          groupId: string;
      };

export const selectGraphFields = {
    id: graphTable.id,
    name: graphTable.name,
    description: graphTable.description,
    groupId: graphTable.groupId,
    userId: graphTable.userId,
    graphId: graphTable.graphId,
    hidden: graphTable.hidden,
    state: graphTable.state,
};

export const getGraphById = async (graphId: string): Promise<GraphRecord | null> => {
    const [graph] = await db.select(selectGraphFields).from(graphTable).where(eq(graphTable.id, graphId)).limit(1);
    return graph ?? null;
};

const requireGroupAccess = async (
    user: AuthUser,
    groupId: string,
    options?: {
        headers?: Headers;
        needsUpdate?: boolean;
        allowAdmin?: boolean;
    }
): Promise<void> => {
    const [group] = await db.select({ id: groupTable.id }).from(groupTable).where(eq(groupTable.id, groupId)).limit(1);

    if (!group) {
        throw new Error(API_ERROR_CODES.GROUP_NOT_FOUND);
    }

    if (options?.allowAdmin && hasRole(user.role, "admin")) {
        return;
    }

    const [membership] = await db
        .select({
            groupId: groupUserTable.groupId,
        })
        .from(groupUserTable)
        .where(and(eq(groupUserTable.groupId, groupId), eq(groupUserTable.userId, user.id)))
        .limit(1);

    if (!membership) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    if (options?.needsUpdate) {
        const permissionCheck = await auth.api.userHasPermission({
            headers: getAuthHeaders(options.headers!),
            body: {
                permissions: {
                    group: ["update"],
                } satisfies KiwiPermissions,
            },
        });

        if (!permissionCheck.success) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }
    }

    return;
};

export const requireGroupUpdateAccess = async (headers: Headers, user: AuthUser, groupId: string): Promise<void> =>
    requireGroupAccess(user, groupId, { headers, needsUpdate: true, allowAdmin: true });

export const requireGroupViewAccess = async (user: AuthUser, groupId: string): Promise<void> =>
    requireGroupAccess(user, groupId);

export const resolveGraphOwnerRoot = async (parentGraphId: string): Promise<RootOwner> => {
    const visited = new Set<string>();
    let currentGraphId = parentGraphId;
    let isRootLookup = true;

    while (true) {
        if (visited.has(currentGraphId)) {
            throw new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER);
        }

        visited.add(currentGraphId);

        const graph = await getGraphById(currentGraphId);
        if (!graph) {
            throw new Error(isRootLookup ? API_ERROR_CODES.GRAPH_NOT_FOUND : API_ERROR_CODES.INVALID_GRAPH_OWNER);
        }

        if (graph.userId) {
            return {
                mode: "user",
                userId: graph.userId,
            };
        }

        if (graph.groupId) {
            return {
                mode: "group",
                groupId: graph.groupId,
            };
        }

        if (!graph.graphId) {
            throw new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER);
        }

        currentGraphId = graph.graphId;
        isRootLookup = false;
    }
};

export const assertCanCreateUnderParentGraph = async (headers: Headers, user: AuthUser, parentGraphId: string) => {
    if (hasRole(user.role, "admin")) {
        await resolveGraphOwnerRoot(parentGraphId);
        return;
    }

    const rootOwner = await resolveGraphOwnerRoot(parentGraphId);
    if (rootOwner.mode === "user") {
        if (rootOwner.userId !== user.id) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }
        return;
    }

    await requireGroupUpdateAccess(headers, user, rootOwner.groupId);
};

const assertGraphAccess = async (
    user: AuthUser,
    graphId: string,
    options?: {
        headers?: Headers;
        needsUpdate?: boolean;
    }
): Promise<GraphRecord> => {
    const graph = await getGraphById(graphId);
    if (!graph) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }

    if (hasRole(user.role, "admin")) {
        return graph;
    }

    const rootOwner = await resolveGraphOwnerRoot(graph.id);
    if (rootOwner.mode === "user") {
        if (rootOwner.userId !== user.id) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }

        return graph;
    }

    if (options?.needsUpdate) {
        await requireGroupUpdateAccess(options.headers!, user, rootOwner.groupId);
    } else {
        await requireGroupViewAccess(user, rootOwner.groupId);
    }

    return graph;
};

export const assertCanPatchGraph = async (headers: Headers, user: AuthUser, graphId: string): Promise<GraphRecord> =>
    assertGraphAccess(user, graphId, { headers, needsUpdate: true });

export const assertCanViewGraph = async (user: AuthUser, graphId: string): Promise<GraphRecord> =>
    assertGraphAccess(user, graphId);
