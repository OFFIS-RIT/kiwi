import { db } from "@kiwi/db";
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

export async function requireConnector(id: string): Promise<ConnectorRow> {
    const [connector] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, id)).limit(1);
    if (!connector) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }
    return connector;
}

export async function requireActiveConnector(id: string, provider?: ConnectorProvider): Promise<ConnectorRow> {
    const connector = await requireConnector(id);
    if (connector.status !== "active" || (provider && connector.provider !== provider)) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
    return connector;
}

export async function assertCanManageConnectorOwner(user: AuthUser, input: { organizationId?: string; teamId?: string }) {
    if (input.teamId) {
        return requireTeamGraphCreateAccess(user, input.teamId);
    }

    if (input.organizationId) {
        return requireOrganizationAdmin(user, input.organizationId);
    }

    return assertCanCreateTopLevelGraph(user);
}

export async function assertCanUseInstallation(user: AuthUser, installationId: string): Promise<ConnectorInstallationRow> {
    const [installation] = await db
        .select()
        .from(connectorInstallationsTable)
        .where(eq(connectorInstallationsTable.id, installationId))
        .limit(1);

    if (!installation || installation.status !== "active") {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }

    await assertCanManageConnectorOwner(user, {
        organizationId: installation.organizationId ?? undefined,
        teamId: installation.teamId ?? undefined,
    });
    return installation;
}

export async function assertCanViewBinding(user: AuthUser, bindingId: string) {
    const [row] = await db
        .select({ binding: connectorResourceBindingsTable, graph: graphTable })
        .from(connectorResourceBindingsTable)
        .innerJoin(graphTable, eq(graphTable.id, connectorResourceBindingsTable.graphId))
        .where(eq(connectorResourceBindingsTable.id, bindingId))
        .limit(1);

    if (!row) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }

    await assertCanViewGraphWithRootOwner(user, row.binding.graphId);
    return row;
}

export async function assertCanSyncBinding(user: AuthUser, bindingId: string) {
    const row = await assertCanViewBinding(user, bindingId);
    await assertCanManageConnectorOwner(user, {
        organizationId: row.graph.organizationId ?? undefined,
        teamId: row.graph.teamId ?? undefined,
    });
    if (!row.binding.webhookEnabled) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
    return row;
}

export async function loadConnectorBindingGraph(bindingId: string) {
    const [row] = await db
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
        .limit(1);

    return row ?? null;
}

export function visibleInstallationWhere(user: AuthUser, connectorId: string) {
    if (user.isSystemAdmin) {
        return eq(connectorInstallationsTable.connectorId, connectorId);
    }

    return and(eq(connectorInstallationsTable.connectorId, connectorId), eq(connectorInstallationsTable.status, "active"));
}
