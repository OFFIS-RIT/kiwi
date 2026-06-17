import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
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

function tryUnknownPromise<T>(thunk: () => PromiseLike<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({ try: thunk, catch: (error) => error });
}

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

export const getGraphById = (graphId: string): Effect.Effect<GraphRecord | null, unknown> =>
    Effect.map(
        tryUnknownPromise(() => db.select(selectGraphFields).from(graphTable).where(eq(graphTable.id, graphId)).limit(1)),
        ([graph]) => graph ?? null
    );

export const resolveGraphOwnerRoot = (parentGraphId: string): Effect.Effect<RootOwner, unknown> =>
    Effect.catchDefect(Effect.gen(function* () {
        const visited = new Set<string>();
        let currentGraphId = parentGraphId;
        let isRootLookup = true;

        while (true) {
            if (visited.has(currentGraphId)) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER));
            }

            visited.add(currentGraphId);

            const graph = yield* getGraphById(currentGraphId);
            if (!graph) {
                return yield* Effect.fail(
                    new Error(isRootLookup ? API_ERROR_CODES.GRAPH_NOT_FOUND : API_ERROR_CODES.INVALID_GRAPH_OWNER)
                );
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
                return yield* Effect.fail(new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER));
            }

            currentGraphId = graph.graphId;
            isRootLookup = false;
        }
    }), (defect) => Effect.fail(defect));

export const assertCanCreateTeamGraph = (user: AuthUser, teamId: string) => requireTeamGraphCreateAccess(user, teamId);

export const assertCanCreateTopLevelGraph = (user: AuthUser) => requireOrganizationAdmin(user);

function assertActiveOrganization(user: AuthUser, organizationId: string): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        const activeOrganizationId = yield* getActiveOrganizationId(user);
        if (activeOrganizationId !== organizationId) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
    });
}

export const assertCanCreateUnderParentGraph = (
    user: AuthUser,
    parentGraphId: string
): Effect.Effect<void, unknown> =>
    Effect.catchDefect(Effect.gen(function* () {
        const rootOwner = yield* resolveGraphOwnerRoot(parentGraphId);

        if (rootOwner.mode === "user") {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        if (rootOwner.mode === "team") {
            yield* requireTeamGraphCreateAccess(user, rootOwner.teamId);
            return;
        }

        yield* assertActiveOrganization(user, rootOwner.organizationId);
        yield* requireOrganizationAdmin(user, rootOwner.organizationId);
    }), (defect) => Effect.fail(defect));

const assertGraphAccessWithRootOwner = (
    user: AuthUser,
    graphId: string,
    options?: {
        needsUpdate?: boolean;
        needsFileManage?: boolean;
    }
): Effect.Effect<{ graph: GraphRecord; rootOwner: RootOwner }, unknown> =>
    Effect.catchDefect(Effect.gen(function* () {
        const graph = yield* getGraphById(graphId);
        if (!graph) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
        }

        const rootOwner = yield* resolveGraphOwnerRoot(graph.id);
        if (rootOwner.mode === "user") {
            if (rootOwner.userId !== user.id) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }

            if (options?.needsUpdate || options?.needsFileManage) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }

            return { graph, rootOwner };
        }

        yield* assertActiveOrganization(user, rootOwner.organizationId);

        if (options?.needsUpdate || options?.needsFileManage) {
            if (rootOwner.mode === "team") {
                if (options.needsFileManage) {
                    yield* requireTeamGraphFileManageAccess(user, rootOwner.teamId);
                } else {
                    yield* requireTeamGraphCreateAccess(user, rootOwner.teamId);
                }
                return { graph, rootOwner };
            }

            yield* requireOrganizationAdmin(user, rootOwner.organizationId);
            return { graph, rootOwner };
        }

        if (rootOwner.mode === "team") {
            yield* requireTeamAccess(user, rootOwner.teamId);
            return { graph, rootOwner };
        }

        yield* requireOrganizationMembership(user, rootOwner.organizationId);
        return { graph, rootOwner };
    }), (defect) => Effect.fail(defect));

const assertGraphAccess = (
    user: AuthUser,
    graphId: string,
    options?: {
        needsUpdate?: boolean;
        needsFileManage?: boolean;
    }
): Effect.Effect<GraphRecord, unknown> =>
    Effect.map(assertGraphAccessWithRootOwner(user, graphId, options), ({ graph }) => graph);

export const assertCanViewGraphWithRootOwner = (
    user: AuthUser,
    graphId: string
): Effect.Effect<{ graph: GraphRecord; rootOwner: RootOwner }, unknown> => assertGraphAccessWithRootOwner(user, graphId);

export const assertCanPatchGraph = (user: AuthUser, graphId: string): Effect.Effect<GraphRecord, unknown> =>
    assertGraphAccess(user, graphId, { needsUpdate: true });

export const assertCanManageGraphFiles = (user: AuthUser, graphId: string): Effect.Effect<GraphRecord, unknown> =>
    assertGraphAccess(user, graphId, { needsFileManage: true });

export const assertCanManageGraphSuggestions = (
    user: AuthUser,
    graphId: string
): Effect.Effect<GraphRecord, unknown> =>
    Effect.catchDefect(Effect.gen(function* () {
        const graph = yield* getGraphById(graphId);
        if (!graph) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
        }

        const rootOwner = yield* resolveGraphOwnerRoot(graph.id);
        if (rootOwner.mode === "user") {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        yield* assertActiveOrganization(user, rootOwner.organizationId);

        if (rootOwner.mode === "team") {
            const access = yield* requireTeamAccess(user, rootOwner.teamId);
            if (access.organizationAdmin || access.role === "admin") {
                return graph;
            }

            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        yield* requireOrganizationAdmin(user, rootOwner.organizationId);
        return graph;
    }), (defect) => Effect.fail(defect));

export const assertCanViewGraph = (user: AuthUser, graphId: string): Effect.Effect<GraphRecord, unknown> =>
    assertGraphAccess(user, graphId);
