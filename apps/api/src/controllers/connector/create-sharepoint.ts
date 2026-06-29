import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { SHAREPOINT_CREDENTIAL_VERSION, SHAREPOINT_PROVIDER } from "@kiwi/connectors";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { SharePointConnectorCreateInput } from "@kiwi/contracts/connectors";
import type { ApiError } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../middleware/auth";
import { encryptCredentials, encryptSecret, toPublicConnector, type PublicConnector } from "../../lib/connectors";
import { assertSystemAdmin } from "../../lib/connector/api";
import { connectorApiErrorOptions, toApiError, tryApiSync } from "../_shared/api-effect";

export function createSharePointConnector(input: {
    user: AuthUser;
    body: SharePointConnectorCreateInput;
}): Effect.Effect<PublicConnector, ApiError, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            yield* tryApiSync(() => assertSystemAdmin(input.user));
            const [connector] = yield* tryDb((db) =>
                db
                    .insert(connectorsTable)
                    .values({
                        provider: SHAREPOINT_PROVIDER,
                        name: input.body.name,
                        slug: input.body.slug,
                        status: "active",
                        encryptedCredentials: encryptCredentials({
                            provider: SHAREPOINT_PROVIDER,
                            subject: "app",
                            version: SHAREPOINT_CREDENTIAL_VERSION,
                            data: {
                                tenantId: input.body.tenantId,
                                clientId: input.body.clientId,
                                clientSecret: input.body.clientSecret,
                            },
                        }),
                        webhookSecretEncrypted: encryptSecret(randomUUID()),
                        createdByUserId: input.user.id,
                    })
                    .returning()
            );

            return toPublicConnector(connector);
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    );
}
