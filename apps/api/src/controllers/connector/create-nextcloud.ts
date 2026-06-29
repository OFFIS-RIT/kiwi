import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { NEXTCLOUD_CREDENTIAL_VERSION, NEXTCLOUD_PROVIDER, normalizeNextcloudBaseUrl } from "@kiwi/connectors";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { NextcloudConnectorCreateInput } from "@kiwi/contracts/connectors";
import type { ApiError } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../middleware/auth";
import { encryptCredentials, encryptSecret, toPublicConnector, type PublicConnector } from "../../lib/connectors";
import { assertSystemAdmin } from "../../lib/connector/api";
import { connectorApiErrorOptions, toApiError, tryApiSync } from "../_shared/api-effect";

export function createNextcloudConnector(input: {
    user: AuthUser;
    body: NextcloudConnectorCreateInput;
}): Effect.Effect<PublicConnector, ApiError, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            yield* tryApiSync(() => assertSystemAdmin(input.user));
            const baseUrl = yield* tryApiSync(() => normalizeNextcloudBaseUrl(input.body.baseUrl));
            const [connector] = yield* tryDb((db) =>
                db
                    .insert(connectorsTable)
                    .values({
                        provider: NEXTCLOUD_PROVIDER,
                        name: input.body.name,
                        slug: input.body.slug,
                        status: "active",
                        encryptedCredentials: encryptCredentials({
                            provider: NEXTCLOUD_PROVIDER,
                            subject: "app",
                            version: NEXTCLOUD_CREDENTIAL_VERSION,
                            data: { baseUrl },
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
