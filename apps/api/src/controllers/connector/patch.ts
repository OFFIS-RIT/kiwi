import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { ConnectorPatchInput } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { encryptSecret, toPublicConnector } from "../../lib/connectors";
import { assertSystemAdmin } from "../../lib/connector/api";
import { connectorApiErrorOptions, toApiError, tryApiSync } from "../_shared/api-effect";

export function patchConnector(input: {
    user: AuthUser;
    connectorId: string;
    body: ConnectorPatchInput;
}): Effect.Effect<ReturnType<typeof toPublicConnector>, ReturnType<typeof toApiError>, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            yield* tryApiSync(() => assertSystemAdmin(input.user));
            const [connector] = yield* tryDb((db) =>
                db
                    .update(connectorsTable)
                    .set({
                        ...(input.body.name ? { name: input.body.name } : {}),
                        ...(input.body.status ? { status: input.body.status } : {}),
                        ...(input.body.webhookSecret
                            ? { webhookSecretEncrypted: encryptSecret(input.body.webhookSecret) }
                            : {}),
                    })
                    .where(eq(connectorsTable.id, input.connectorId))
                    .returning()
            );

            if (!connector) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
            }

            return toPublicConnector(connector);
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    );
}
