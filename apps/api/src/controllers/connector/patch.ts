import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { ConnectorPatchInput } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES, type ApiError } from "@kiwi/contracts/errors";
import { eq } from "@kiwi/db/drizzle";
import type { AuthUser } from "../../middleware/auth";
import { encryptSecret, toPublicConnector, type PublicConnector } from "../../lib/connectors";
import { assertSystemAdmin } from "../../lib/connector/api";
import { connectorApiErrorOptions, toApiError, tryApiSync } from "../_shared/api-effect";

export const patchConnector: (input: {
    user: AuthUser;
    connectorId: string;
    body: ConnectorPatchInput;
}) => Effect.Effect<PublicConnector, ApiError, Database> = Effect.fn("patchConnector")((input) =>
    Effect.mapError(
        Effect.gen(function* () {
            yield* tryApiSync(() => assertSystemAdmin(input.user));
            const [existing] = yield* tryDb((db) =>
                db.select().from(connectorsTable).where(eq(connectorsTable.id, input.connectorId)).limit(1)
            );
            if (!existing) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
            }
            if (existing.provider === "gitlab" && input.body.status === "active") {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }
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
    )
);
