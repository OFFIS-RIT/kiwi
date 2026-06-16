import { db } from "@kiwi/db";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { ConnectorPatchInput } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { encryptSecret, toPublicConnector } from "../../lib/connectors";
import { assertSystemAdmin } from "../../lib/connector/api";
import { tryApiPromise } from "../_shared/api-effect";

export function patchConnector(input: { user: AuthUser; connectorId: string; body: ConnectorPatchInput }) {
    return tryApiPromise(async () => {
        assertSystemAdmin(input.user);
        const [connector] = await db
            .update(connectorsTable)
            .set({
                ...(input.body.name ? { name: input.body.name } : {}),
                ...(input.body.status ? { status: input.body.status } : {}),
                ...(input.body.webhookSecret ? { webhookSecretEncrypted: encryptSecret(input.body.webhookSecret) } : {}),
            })
            .where(eq(connectorsTable.id, input.connectorId))
            .returning();
    
        if (!connector) {
            throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
        }
    
        return toPublicConnector(connector);
    });
}
