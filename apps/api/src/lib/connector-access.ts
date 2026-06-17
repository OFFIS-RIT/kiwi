import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import {
    connectorInstallationsTable,
    connectorResourceBindingsTable,
    connectorsTable,
    type ConnectorProvider,
} from "@kiwi/db/tables/connectors";
import { graphTable } from "@kiwi/db/tables/graph";
import { and, eq } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth";
import { API_ERROR_CODES } from "../types";
import { assertCanCreateTopLevelGraph, assertCanViewGraphWithRootOwner } from "./graph/access";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "./team/access";

export type ConnectorRow = typeof connectorsTable.$inferSelect;
export type ConnectorInstallationRow = typeof connectorInstallationsTable.$inferSelect;
export type ConnectorResourceBindingRow = typeof connectorResourceBindingsTable.$inferSelect;

function tryUnknownPromise<T>(thunk: () => PromiseLike<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({ try: thunk, catch: (error) => error });
}

export function requireConnector(id: string): Effect.Effect<ConnectorRow, unknown> {
    return Effect.gen(function* () {
        const [connector] = yield* tryUnknownPromise(() =>
            db.select().from(connectorsTable).where(eq(connectorsTable.id, id)).limit(1)
        );
        if (!connector) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
        }
        return connector;
    });
}

export function requireActiveConnector(id: string, provider?: ConnectorProvider): Effect.Effect<ConnectorRow, unknown> {
    return Effect.gen(function* () {
        const connector = yield* requireConnector(id);
        if (connector.status !== "active" || (provider && connector.provider !== provider)) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
        return connector;
    });
}

export function assertCanManageConnectorOwner(
    user: AuthUser,
    input: { organizationId?: string; teamId?: string }
): Effect.Effect<unknown, unknown> {
    if (input.teamId) {
        return requireTeamGraphCreateAccess(user, input.teamId);
    }

    if (input.organizationId) {
        return requireOrganizationAdmin(user, input.organizationId);
    }

    return assertCanCreateTopLevelGraph(user);
}

export function assertCanUseInstallation(
    user: AuthUser,
    installationId: string
): Effect.Effect<ConnectorInstallationRow, unknown> {
    return Effect.gen(function* () {
        const [installation] = yield* tryUnknownPromise(() =>
            db
                .select()
                .from(connectorInstallationsTable)
                .where(eq(connectorInstallationsTable.id, installationId))
                .limit(1)
        );

        if (!installation || installation.status !== "active") {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        yield* assertCanManageConnectorOwner(user, {
            organizationId: installation.organizationId ?? undefined,
            teamId: installation.teamId ?? undefined,
        });
        return installation;
    });
}

export function assertCanViewBinding(user: AuthUser, bindingId: string) {
    return Effect.gen(function* () {
        const [row] = yield* tryUnknownPromise(() =>
            db
                .select({ binding: connectorResourceBindingsTable, graph: graphTable })
                .from(connectorResourceBindingsTable)
                .innerJoin(graphTable, eq(graphTable.id, connectorResourceBindingsTable.graphId))
                .where(eq(connectorResourceBindingsTable.id, bindingId))
                .limit(1)
        );

        if (!row) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
        }

        yield* assertCanViewGraphWithRootOwner(user, row.binding.graphId);
        return row;
    });
}

export function assertCanSyncBinding(user: AuthUser, bindingId: string) {
    return Effect.gen(function* () {
        const row = yield* assertCanViewBinding(user, bindingId);
        yield* assertCanManageConnectorOwner(user, {
            organizationId: row.graph.organizationId ?? undefined,
            teamId: row.graph.teamId ?? undefined,
        });
        if (!row.binding.webhookEnabled) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
        return row;
    });
}

export function loadConnectorBindingGraph(bindingId: string) {
    return Effect.gen(function* () {
        const [row] = yield* tryUnknownPromise(() =>
            db
                .select({
                    binding: connectorResourceBindingsTable,
                    installation: connectorInstallationsTable,
                    connector: connectorsTable,
                    graph: graphTable,
                })
                .from(connectorResourceBindingsTable)
                .innerJoin(
                    connectorInstallationsTable,
                    eq(connectorInstallationsTable.id, connectorResourceBindingsTable.connectorInstallationId)
                )
                .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
                .innerJoin(graphTable, eq(graphTable.id, connectorResourceBindingsTable.graphId))
                .where(eq(connectorResourceBindingsTable.id, bindingId))
                .limit(1)
        );

        return row ?? null;
    });
}

export function visibleInstallationWhere(user: AuthUser, connectorId: string) {
    if (user.isSystemAdmin) {
        return eq(connectorInstallationsTable.connectorId, connectorId);
    }

    return and(eq(connectorInstallationsTable.connectorId, connectorId), eq(connectorInstallationsTable.status, "active"));
}
