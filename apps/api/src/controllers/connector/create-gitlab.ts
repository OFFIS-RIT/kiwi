import { db } from "@kiwi/db";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { GitLabConnectorCreateInput } from "@kiwi/contracts/connectors";
import type { AuthUser } from "../../middleware/auth";
import { encryptCredentials, encryptSecret, toPublicConnector } from "../../lib/connectors";
import { assertSystemAdmin } from "../../lib/connector/api";
import { tryApiPromise } from "../_shared/api-effect";

export function createGitLabConnector(input: { user: AuthUser; body: GitLabConnectorCreateInput }) {
    return tryApiPromise(async () => {
        assertSystemAdmin(input.user);
        const [connector] = await db
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
            .returning();
    
        return toPublicConnector(connector);
    });
}
