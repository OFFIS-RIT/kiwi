import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { GitLabConnectorCreateInput } from "@kiwi/contracts/connectors";
import type { AuthUser } from "../../middleware/auth";
import { encryptCredentials, encryptSecret, toPublicConnector } from "../../lib/connectors";
import { assertSystemAdmin } from "../../lib/connector/api";
import { connectorApiErrorOptions, toApiError, tryApiSync } from "../_shared/api-effect";

export function createGitLabConnector(input: {
    user: AuthUser;
    body: GitLabConnectorCreateInput;
}): Effect.Effect<ReturnType<typeof toPublicConnector>, ReturnType<typeof toApiError>, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            yield* tryApiSync(() => assertSystemAdmin(input.user));
            const [connector] = yield* tryDb((db) =>
                db
                    .insert(connectorsTable)
                    .values({
                        provider: "gitlab",
                        name: input.body.name,
                        slug: input.body.slug,
                        status: "disabled",
                        appId: input.body.clientId,
                        clientId: input.body.clientId,
                        encryptedCredentials: encryptCredentials({
                            provider: "gitlab",
                            baseUrl: input.body.baseUrl,
                            clientId: input.body.clientId,
                            clientSecret: input.body.clientSecret,
                        }),
                        webhookSecretEncrypted: encryptSecret(input.body.webhookSecret),
                        createdByUserId: input.user.id,
                    })
                    .returning()
            );

            return toPublicConnector(connector);
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    );
}
