import * as Effect from "effect/Effect";
import { getConnectorAdapterRegistryEntry } from "@kiwi/connectors";
import { decryptConnectorCredentials, isInstallationCredentialsForProvider } from "@kiwi/connectors/credentials";
import { and, eq, or } from "@kiwi/db/drizzle";
import { tryDb, type Database, type DatabaseError } from "@kiwi/db/effect";
import { connectorInstallationsTable, connectorsTable } from "@kiwi/db/tables/connectors";
import { API_ERROR_CODES, makeApiError, type ApiError } from "@kiwi/contracts/errors";
import { env } from "../../env";

const BOT_CONNECTOR_NOT_FOUND = makeApiError(
    404,
    API_ERROR_CODES.GRAPH_NOT_FOUND,
    "Chat bot connector installation was not found"
);

const INVALID_BOT_CONNECTOR = makeApiError(403, API_ERROR_CODES.FORBIDDEN, "Connector provider is not a chat bot");

export type ChatBotConnectorInstallationLookup = {
    provider: string;
    organizationId: string;
    connectorId: string;
    installationId: string;
    installState: "active" | "disabled" | "pending";
    providerInstallationId: string;
    providerAccountLogin: string;
    providerAccountType: string | null;
    botCredentials: unknown;
    workspaceMetadata: {
        providerInstallationId: string;
        providerAccountLogin: string;
        providerAccountType: string | null;
    };
};

export const loadChatBotConnectorInstallation: (input: {
    provider: string;
    organizationId: string;
}) => Effect.Effect<ChatBotConnectorInstallationLookup, ApiError | DatabaseError, Database> = Effect.fn(
    "loadChatBotConnectorInstallation"
)(function* (input) {
    const entry = yield* Effect.try({
        try: () => getConnectorAdapterRegistryEntry(input.provider),
        catch: () => INVALID_BOT_CONNECTOR,
    });
    if (entry.family !== "chat-bot") {
        return yield* Effect.fail(INVALID_BOT_CONNECTOR);
    }

    const [row] = yield* tryDb((db) =>
        db
            .select({ connector: connectorsTable, installation: connectorInstallationsTable })
            .from(connectorInstallationsTable)
            .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
            .where(
                and(
                    eq(connectorsTable.provider, input.provider),
                    eq(connectorsTable.status, "active"),
                    eq(connectorInstallationsTable.status, "active"),
                    eq(connectorInstallationsTable.subjectKind, "organization"),
                    or(
                        eq(connectorInstallationsTable.subjectOrganizationId, input.organizationId),
                        eq(connectorInstallationsTable.organizationId, input.organizationId)
                    )
                )
            )
            .limit(1)
    );
    if (!row?.installation.encryptedCredentials) {
        return yield* Effect.fail(BOT_CONNECTOR_NOT_FOUND);
    }

    const credentials = decryptConnectorCredentials(row.installation.encryptedCredentials, env.AUTH_SECRET);
    if (!isInstallationCredentialsForProvider(credentials, input.provider)) {
        return yield* Effect.fail(INVALID_BOT_CONNECTOR);
    }

    return {
        provider: input.provider,
        organizationId: input.organizationId,
        connectorId: row.connector.id,
        installationId: row.installation.id,
        installState: row.installation.status,
        providerInstallationId: row.installation.providerInstallationId,
        providerAccountLogin: row.installation.providerAccountLogin,
        providerAccountType: row.installation.providerAccountType,
        botCredentials: credentials,
        workspaceMetadata: {
            providerInstallationId: row.installation.providerInstallationId,
            providerAccountLogin: row.installation.providerAccountLogin,
            providerAccountType: row.installation.providerAccountType,
        },
    };
});
