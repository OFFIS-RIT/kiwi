import { tryDb, type Database } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";
import { graphTable } from "@kiwi/db/tables/graph";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { forbiddenError, graphNotFoundError, invalidGraphOwnerError } from "@kiwi/contracts/errors";
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

export const getGraphById: (graphId: string) => Effect.Effect<GraphRecord | null, unknown, Database> = Effect.fn(
    "getGraphById"
)((graphId: string) =>
    Effect.map(
        tryDb((db) => db.select(selectGraphFields).from(graphTable).where(eq(graphTable.id, graphId)).limit(1)),
        ([graph]) => graph ?? null
    )
);

export const resolveGraphOwnerRoot: (parentGraphId: string) => Effect.Effect<RootOwner, unknown, Database> = Effect.fn(
    "resolveGraphOwnerRoot"
)(function* (parentGraphId: string) {
    const visited = new Set<string>();
    let currentGraphId = parentGraphId;
    let isRootLookup = true;

    while (true) {
        if (visited.has(currentGraphId)) {
            return yield* Effect.fail(invalidGraphOwnerError());
        }

        visited.add(currentGraphId);

        const graph = yield* getGraphById(currentGraphId);
        if (!graph) {
            return yield* Effect.fail(isRootLookup ? graphNotFoundError() : invalidGraphOwnerError());
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
            return yield* Effect.fail(invalidGraphOwnerError());
        }

        currentGraphId = graph.graphId;
        isRootLookup = false;
    }
});

export const assertCanCreateTeamGraph = Effect.fn("assertCanCreateTeamGraph")((user: AuthUser, teamId: string) =>
    requireTeamGraphCreateAccess(user, teamId)
);

export const assertCanCreateTopLevelGraph = Effect.fn("assertCanCreateTopLevelGraph")((user: AuthUser) =>
    requireOrganizationAdmin(user)
);

function assertActiveOrganization(user: AuthUser, organizationId: string): Effect.Effect<void, unknown, Database> {
    return Effect.gen(function* () {
        const activeOrganizationId = yield* getActiveOrganizationId(user);
        if (activeOrganizationId !== organizationId) {
            return yield* Effect.fail(forbiddenError());
        }
    });
}

export const assertCanCreateUnderParentGraph: (
    user: AuthUser,
    parentGraphId: string
) => Effect.Effect<void, unknown, Database> = Effect.fn("assertCanCreateUnderParentGraph")(function* (
    user: AuthUser,
    parentGraphId: string
) {
    const rootOwner = yield* resolveGraphOwnerRoot(parentGraphId);

    if (rootOwner.mode === "user") {
        return yield* Effect.fail(forbiddenError());
    }

    if (rootOwner.mode === "team") {
        yield* requireTeamGraphCreateAccess(user, rootOwner.teamId);
        return;
    }

    yield* assertActiveOrganization(user, rootOwner.organizationId);
    yield* requireOrganizationAdmin(user, rootOwner.organizationId);
});

const assertGraphAccessWithRootOwner = (
    user: AuthUser,
    graphId: string,
    options?: {
        needsUpdate?: boolean;
        needsFileManage?: boolean;
    }
): Effect.Effect<{ graph: GraphRecord; rootOwner: RootOwner }, unknown, Database> =>
    Effect.gen(function* () {
        const graph = yield* getGraphById(graphId);
        if (!graph) {
            return yield* Effect.fail(graphNotFoundError());
        }

        const rootOwner = yield* resolveGraphOwnerRoot(graph.id);
        if (rootOwner.mode === "user") {
            if (rootOwner.userId !== user.id) {
                return yield* Effect.fail(forbiddenError());
            }

            if (options?.needsUpdate || options?.needsFileManage) {
                return yield* Effect.fail(forbiddenError());
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
    });

const assertGraphAccess = (
    user: AuthUser,
    graphId: string,
    options?: {
        needsUpdate?: boolean;
        needsFileManage?: boolean;
    }
): Effect.Effect<GraphRecord, unknown, Database> =>
    Effect.map(assertGraphAccessWithRootOwner(user, graphId, options), ({ graph }) => graph);

export const assertCanViewGraphWithRootOwner: (
    user: AuthUser,
    graphId: string
) => Effect.Effect<{ graph: GraphRecord; rootOwner: RootOwner }, unknown, Database> = Effect.fn(
    "assertCanViewGraphWithRootOwner"
)((user: AuthUser, graphId: string) => assertGraphAccessWithRootOwner(user, graphId));

export const assertCanPatchGraph: (user: AuthUser, graphId: string) => Effect.Effect<GraphRecord, unknown, Database> =
    Effect.fn("assertCanPatchGraph")((user: AuthUser, graphId: string) =>
        assertGraphAccess(user, graphId, { needsUpdate: true })
    );

export const assertCanManageGraphFiles: (
    user: AuthUser,
    graphId: string
) => Effect.Effect<GraphRecord, unknown, Database> = Effect.fn("assertCanManageGraphFiles")(
    (user: AuthUser, graphId: string) => assertGraphAccess(user, graphId, { needsFileManage: true })
);

export const assertCanManageGraphSuggestions: (
    user: AuthUser,
    graphId: string
) => Effect.Effect<GraphRecord, unknown, Database> = Effect.fn("assertCanManageGraphSuggestions")(function* (
    user: AuthUser,
    graphId: string
) {
    const graph = yield* getGraphById(graphId);
    if (!graph) {
        return yield* Effect.fail(graphNotFoundError());
    }

    const rootOwner = yield* resolveGraphOwnerRoot(graph.id);
    if (rootOwner.mode === "user") {
        return yield* Effect.fail(forbiddenError());
    }

    yield* assertActiveOrganization(user, rootOwner.organizationId);

    if (rootOwner.mode === "team") {
        const access = yield* requireTeamAccess(user, rootOwner.teamId);
        if (access.organizationAdmin || access.role === "admin") {
            return graph;
        }

        return yield* Effect.fail(forbiddenError());
    }

    yield* requireOrganizationAdmin(user, rootOwner.organizationId);
    return graph;
});

export const assertCanViewGraph: (user: AuthUser, graphId: string) => Effect.Effect<GraphRecord, unknown, Database> =
    Effect.fn("assertCanViewGraph")((user: AuthUser, graphId: string) => assertGraphAccess(user, graphId));
