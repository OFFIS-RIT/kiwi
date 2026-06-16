import { db } from "@kiwi/db";
import { connectorInstallationsTable } from "@kiwi/db/tables/connectors";
import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { assertCanUseInstallation, requireActiveConnector } from "../../../lib/connector-access";
import { toPublicInstallation } from "../../../lib/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function listConnectorInstallations(input: { user: AuthUser; connectorId: string }) {
    return tryApiPromise(async () => {
        await requireActiveConnector(input.connectorId);
        const rows = await db
            .select()
            .from(connectorInstallationsTable)
            .where(
                and(
                    eq(connectorInstallationsTable.connectorId, input.connectorId),
                    eq(connectorInstallationsTable.status, "active")
                )
            )
            .orderBy(asc(connectorInstallationsTable.providerAccountLogin));
    
        const visible = [];
        for (const row of rows) {
            const allowed = await Result.tryPromise(async () => assertCanUseInstallation(input.user, row.id));
            if (!allowed.isErr()) {
                visible.push(toPublicInstallation(row));
            }
        }
        return visible;
    });
}
