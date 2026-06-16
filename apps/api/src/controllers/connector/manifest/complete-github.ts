import { ulid } from "ulid";
import { db } from "@kiwi/db";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import type { GitHubManifestCallbackQuery } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../../middleware/auth";
import {
    encryptCredentials,
    encryptSecret,
    exchangeGitHubManifestCode,
    toPublicConnector,
    verifyConnectorState,
} from "../../../lib/connectors";
import { assertSystemAdmin } from "../../../lib/connector/api";
import { tryApiPromise } from "../../_shared/api-effect";

export function completeGitHubConnectorManifest(input: { user: AuthUser; query: GitHubManifestCallbackQuery }) {
    return tryApiPromise(async () => {
        assertSystemAdmin(input.user);
        if (!verifyConnectorState(input.query.state, "github-manifest", input.user.id)) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }
    
        const app = await exchangeGitHubManifestCode(input.query.code);
        const slug = app.slug ?? `github-${String(app.id)}`;
        const [connector] = await db
            .insert(connectorsTable)
            .values({
                provider: "github",
                name: app.name,
                slug,
                appId: String(app.id),
                appSlug: slug,
                clientId: app.client_id ?? null,
                encryptedCredentials: encryptCredentials({
                    provider: "github",
                    appId: String(app.id),
                    privateKeyPem: app.pem,
                    clientId: app.client_id,
                    clientSecret: app.client_secret,
                }),
                webhookSecretEncrypted: encryptSecret(app.webhook_secret ?? ulid()),
                createdByUserId: input.user.id,
            })
            .returning();
    
        return toPublicConnector(connector);
    });
}
