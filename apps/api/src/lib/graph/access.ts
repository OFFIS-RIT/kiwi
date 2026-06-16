import { db } from "@kiwi/db";
import { graphTable } from "@kiwi/db/tables/graph";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { API_ERROR_CODES } from "../../types";
import {
    getActiveOrganizationId,
    requireOrganizationAdmin,
    requireOrganizationMembership,
    requireTeamAccess,
    requireTeamGraphCreateAccess,
    requireTeamGraphFileManageAccess,
} from "../team/access";
import type { GraphRecord } from "../../types/routes";

export type { GraphRecord } from "../../types/routes";

export type RootOwner =
    | {
          mode: "user";
          userId: string;
      }
    | {
          mode: "organization";
          organizationId: string;
      }
    | {
          mode: "team";
          organizationId: string;
          teamId: string;
      };

export const selectGraphFields = {
    id: graphTable.id,
    name: graphTable.name,
    description: graphTable.description,
    organizationId: graphTable.organizationId,
    teamId: graphTable.teamId,
    userId: graphTable.userId,
    graphId: graphTable.graphId,
    hidden: graphTable.hidden,
    state: graphTable.state,
};

export const getGraphById = async (graphId: string): Promise<GraphRecord | null> => {
    const [graph] = await db.select(selectGraphFields).from(graphTable).where(eq(graphTable.id, graphId)).limit(1);
    return graph ?? null;
};

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

        if (graph.organizationId) {
            if (graph.teamId) {
                return {
                    mode: "team",
                    organizationId: graph.organizationId,
                    teamId: graph.teamId,
                };
            }

            return {
                mode: "organization",
                organizationId: graph.organizationId,
            };
        }

        if (!graph.graphId) {
            throw new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER);
        }

        currentGraphId = graph.graphId;
        isRootLookup = false;
    }
};

export const assertCanCreateTeamGraph = async (user: AuthUser, teamId: string) => {
    return requireTeamGraphCreateAccess(user, teamId);
};

export const assertCanCreateTopLevelGraph = async (user: AuthUser) => {
    return requireOrganizationAdmin(user);
};

async function assertActiveOrganization(user: AuthUser, organizationId: string) {
    if ((await getActiveOrganizationId(user)) !== organizationId) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

export const assertCanCreateUnderParentGraph = async (user: AuthUser, parentGraphId: string) => {
    const rootOwner = await resolveGraphOwnerRoot(parentGraphId);

    if (rootOwner.mode === "user") {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    if (rootOwner.mode === "team") {
        await requireTeamGraphCreateAccess(user, rootOwner.teamId);
        return;
    }

    await assertActiveOrganization(user, rootOwner.organizationId);
    await requireOrganizationAdmin(user, rootOwner.organizationId);
};

const assertGraphAccessWithRootOwner = async (
    user: AuthUser,
    graphId: string,
    options?: {
        needsUpdate?: boolean;
        needsFileManage?: boolean;
    }
): Promise<{ graph: GraphRecord; rootOwner: RootOwner }> => {
    const graph = await getGraphById(graphId);
    if (!graph) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }

    const rootOwner = await resolveGraphOwnerRoot(graph.id);
    if (rootOwner.mode === "user") {
        if (rootOwner.userId !== user.id) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }

        if (options?.needsUpdate || options?.needsFileManage) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }

        return { graph, rootOwner };
    }

    await assertActiveOrganization(user, rootOwner.organizationId);

    if (options?.needsUpdate || options?.needsFileManage) {
        if (rootOwner.mode === "team") {
            if (options.needsFileManage) {
                await requireTeamGraphFileManageAccess(user, rootOwner.teamId);
            } else {
                await requireTeamGraphCreateAccess(user, rootOwner.teamId);
            }
            return { graph, rootOwner };
        }

        await requireOrganizationAdmin(user, rootOwner.organizationId);
        return { graph, rootOwner };
    }

    if (rootOwner.mode === "team") {
        await requireTeamAccess(user, rootOwner.teamId);
        return { graph, rootOwner };
    }

    await requireOrganizationMembership(user, rootOwner.organizationId);
    return { graph, rootOwner };
};

const assertGraphAccess = async (
    user: AuthUser,
    graphId: string,
    options?: {
        needsUpdate?: boolean;
        needsFileManage?: boolean;
    }
): Promise<GraphRecord> => (await assertGraphAccessWithRootOwner(user, graphId, options)).graph;

export const assertCanViewGraphWithRootOwner = (
    user: AuthUser,
    graphId: string
): Promise<{ graph: GraphRecord; rootOwner: RootOwner }> => assertGraphAccessWithRootOwner(user, graphId);

export const assertCanPatchGraph = async (user: AuthUser, graphId: string): Promise<GraphRecord> =>
    assertGraphAccess(user, graphId, { needsUpdate: true });

export const assertCanManageGraphFiles = async (user: AuthUser, graphId: string): Promise<GraphRecord> =>
    assertGraphAccess(user, graphId, { needsFileManage: true });

export const assertCanManageGraphSuggestions = async (user: AuthUser, graphId: string): Promise<GraphRecord> => {
    const graph = await getGraphById(graphId);
    if (!graph) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }

    const rootOwner = await resolveGraphOwnerRoot(graph.id);
    if (rootOwner.mode === "user") {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    await assertActiveOrganization(user, rootOwner.organizationId);

    if (rootOwner.mode === "team") {
        const access = await requireTeamAccess(user, rootOwner.teamId);
        if (access.organizationAdmin || access.role === "admin") {
            return graph;
        }

        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    await requireOrganizationAdmin(user, rootOwner.organizationId);
    return graph;
};

export const assertCanViewGraph = async (user: AuthUser, graphId: string): Promise<GraphRecord> =>
    assertGraphAccess(user, graphId);
