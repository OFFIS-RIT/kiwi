import { DatabaseError, tryDb, type Database } from "@kiwi/db/effect";
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
import {
    API_ERROR_CODES,
    forbiddenError,
    graphNotFoundError,
    internalServerError,
    isApiError,
    makeApiError,
    type ApiError,
} from "@kiwi/contracts/errors";
import { assertCanCreateTopLevelGraph, assertCanViewGraphWithRootOwner } from "./graph/access";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "./team/access";

export type ConnectorRow = typeof connectorsTable.$inferSelect;
export type ConnectorInstallationRow = typeof connectorInstallationsTable.$inferSelect;
export type ConnectorResourceBindingRow = typeof connectorResourceBindingsTable.$inferSelect;

function toConnectorAccessError(error: unknown): ApiError | DatabaseError {
    if (error instanceof DatabaseError) {
        return error;
    }
    if (isApiError(error)) {
        return error;
    }
    const code = error instanceof Error ? error.message.replace(/^Unhandled exception:\s*/u, "") : "";
    if (code === API_ERROR_CODES.FORBIDDEN) {
        return forbiddenError();
    }
    if (code === API_ERROR_CODES.GRAPH_NOT_FOUND) {
        return graphNotFoundError();
    }
    if (code === API_ERROR_CODES.ORGANIZATION_NOT_FOUND) {
        return makeApiError(404, API_ERROR_CODES.ORGANIZATION_NOT_FOUND, "Organization not found");
    }
    if (code === API_ERROR_CODES.TEAM_NOT_FOUND) {
        return makeApiError(404, API_ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
    }
    return internalServerError();
}

function mapConnectorAccessEffect<T, E, R>(
    effect: Effect.Effect<T, E, R>
): Effect.Effect<T, ApiError | DatabaseError, R> {
    return Effect.mapError(effect, toConnectorAccessError);
}

export function requireConnector(id: string): Effect.Effect<ConnectorRow, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        const [connector] = yield* tryDb((db) =>
            db.select().from(connectorsTable).where(eq(connectorsTable.id, id)).limit(1)
        );
        if (!connector) {
            return yield* Effect.fail(graphNotFoundError());
        }
        return connector;
    });
}

export function requireActiveConnector(
    id: string,
    provider?: ConnectorProvider
): Effect.Effect<ConnectorRow, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        const connector = yield* requireConnector(id);
        if (connector.status !== "active" || (provider && connector.provider !== provider)) {
            return yield* Effect.fail(forbiddenError());
        }
        return connector;
    });
}

export function assertCanManageConnectorOwner(
    user: AuthUser,
    input: { organizationId?: string; teamId?: string }
): Effect.Effect<void, ApiError | DatabaseError, Database> {
    if (input.teamId) {
        return Effect.asVoid(mapConnectorAccessEffect(requireTeamGraphCreateAccess(user, input.teamId)));
    }

    if (input.organizationId) {
        return Effect.asVoid(mapConnectorAccessEffect(requireOrganizationAdmin(user, input.organizationId)));
    }

    return Effect.asVoid(mapConnectorAccessEffect(assertCanCreateTopLevelGraph(user)));
}

export function assertCanUseInstallation(
    user: AuthUser,
    installationId: string
): Effect.Effect<ConnectorInstallationRow, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        const [installation] = yield* tryDb((db) =>
            db
                .select()
                .from(connectorInstallationsTable)
                .where(eq(connectorInstallationsTable.id, installationId))
                .limit(1)
        );

        if (!installation || installation.status !== "active") {
            return yield* Effect.fail(forbiddenError());
        }

        yield* assertCanManageConnectorOwner(user, {
            organizationId: installation.organizationId ?? undefined,
            teamId: installation.teamId ?? undefined,
        });
        return installation;
    });
}

export function assertCanViewBinding(
    user: AuthUser,
    bindingId: string
): Effect.Effect<
    { binding: ConnectorResourceBindingRow; graph: typeof graphTable.$inferSelect },
    ApiError | DatabaseError,
    Database
> {
    return Effect.gen(function* () {
        const [row] = yield* tryDb((db) =>
            db
                .select({ binding: connectorResourceBindingsTable, graph: graphTable })
                .from(connectorResourceBindingsTable)
                .innerJoin(graphTable, eq(graphTable.id, connectorResourceBindingsTable.graphId))
                .where(eq(connectorResourceBindingsTable.id, bindingId))
                .limit(1)
        );

        if (!row) {
            return yield* Effect.fail(graphNotFoundError());
        }

        yield* mapConnectorAccessEffect(assertCanViewGraphWithRootOwner(user, row.binding.graphId));
        return row;
    });
}

export function assertCanSyncBinding(
    user: AuthUser,
    bindingId: string
): Effect.Effect<
    { binding: ConnectorResourceBindingRow; graph: typeof graphTable.$inferSelect },
    ApiError | DatabaseError,
    Database
> {
    return Effect.gen(function* () {
        const row = yield* assertCanViewBinding(user, bindingId);
        yield* assertCanManageConnectorOwner(user, {
            organizationId: row.graph.organizationId ?? undefined,
            teamId: row.graph.teamId ?? undefined,
        });
        if (!row.binding.webhookEnabled) {
            return yield* Effect.fail(forbiddenError());
        }
        return row;
    });
}

export function loadConnectorBindingGraph(bindingId: string): Effect.Effect<
    {
        binding: ConnectorResourceBindingRow;
        installation: ConnectorInstallationRow;
        connector: ConnectorRow;
        graph: typeof graphTable.$inferSelect;
    } | null,
    DatabaseError,
    Database
> {
    return Effect.gen(function* () {
        const [row] = yield* tryDb((db) =>
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

    return and(
        eq(connectorInstallationsTable.connectorId, connectorId),
        eq(connectorInstallationsTable.status, "active")
    );
}
