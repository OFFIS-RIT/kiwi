import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { connectorInstallationsTable } from "@kiwi/db/tables/connectors";
import { and, asc, eq } from "drizzle-orm";
import { assertCanUseInstallation, requireActiveConnector } from "../../../lib/connector-access";
import { toPublicInstallation } from "../../../lib/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";
export function listConnectorInstallations(input: { user: AuthUser; connectorId: string }) {
    return Effect.mapError(Effect.gen(function* () {
        yield* requireActiveConnector(input.connectorId);
        const rows = yield* Effect.tryPromise(() =>
            db
                .select()
                .from(connectorInstallationsTable)
                .where(
                    and(
                        eq(connectorInstallationsTable.connectorId, input.connectorId),
                        eq(connectorInstallationsTable.status, "active")
                    )
                )
                .orderBy(asc(connectorInstallationsTable.providerAccountLogin))
        );
    
        const visible = [];
        for (const row of rows) {
            const allowed = yield* Effect.match(assertCanUseInstallation(input.user, row.id), {
                onFailure: () => false,
                onSuccess: () => true,
            });
            if (allowed) {
                visible.push(toPublicInstallation(row));
            }
        }
        return visible;
    }), (error) => toApiError(error, connectorApiErrorOptions));
}
