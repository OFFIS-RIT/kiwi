import { createConnectorAdapter, isKnownConnectorProvider } from "@kiwi/connectors";
import * as Effect from "effect/Effect";
import type { ConnectorFileLocator, ConnectorInstallationCredentials, ConnectorProvider } from "@kiwi/connectors";
import {
    decryptConnectorCredentials,
    isConnectorCredentialsForProvider,
    isInstallationCredentialsForProvider,
} from "@kiwi/connectors/credentials";
import type { Database } from "@kiwi/db/effect";
import { withWorkerDb } from "../runtime/effect";
import {
    connectorInstallationsTable,
    connectorsTable,
    connectorResourceBindingsTable,
} from "@kiwi/db/tables/connectors";
import { getFile, type FileStorage } from "@kiwi/files";
import { eq } from "@kiwi/db/drizzle";
import { env } from "../../env";
import { parseCodeFileMetadata } from "../code/metadata";

export type FileContentSource =
    | { kind: "internal"; key: string }
    | { kind: "external"; provider: "github"; url: string; metadata?: string | null }
    | { kind: "connector"; bindingId: string; provider: ConnectorProvider; metadata?: string | null };

type CompatibleCodeFileMetadata = {
    bindingId?: string;
    providerResourceId?: string;
    providerFileId?: string;
    path: string;
    versionId?: string;
    etag?: string;
    git?: { commitSha?: string };
};

const MAX_CODE_FILE_BYTES = 2 * 1024 * 1024;

export function fileContentSourceFromRow(row: {
    key: string;
    storageKind?: string | null;
    externalProvider?: string | null;
    externalUrl?: string | null;
    connectorBindingId?: string | null;
    metadata?: string | null;
}): FileContentSource {
    if (row.storageKind === "external") {
        if (row.connectorBindingId) {
            if (!row.externalProvider || !isKnownConnectorProvider(row.externalProvider)) {
                throw new Error("Unsupported connector file source");
            }
            return {
                kind: "connector",
                provider: row.externalProvider,
                bindingId: row.connectorBindingId,
                metadata: row.metadata,
            };
        }

        if (row.externalProvider !== "github" || !row.externalUrl) {
            throw new Error("Unsupported external file source");
        }

        return { kind: "external", provider: "github", url: row.externalUrl, metadata: row.metadata };
    }

    return { kind: "internal", key: row.key };
}

export function readFileContentSource(
    source: FileContentSource
): Effect.Effect<string | null, unknown, Database | FileStorage> {
    return Effect.gen(function* () {
        if (source.kind === "internal") {
            const file = yield* getFile(source.key, env.S3_BUCKET, "text");
            return file?.content ?? null;
        }

        if (source.kind === "connector") {
            return yield* readConnectorFile(source.bindingId, source.metadata);
        }

        return yield* readExternalGitHubFile(source.url);
    });
}

function readConnectorFile(
    bindingId: string,
    metadataValue?: string | null
): Effect.Effect<string | null, unknown, Database> {
    return Effect.gen(function* () {
        const metadata = parseCodeFileMetadata(metadataValue) as CompatibleCodeFileMetadata | null;
        if (!metadata) {
            return null;
        }

        const [row] = yield* withWorkerDb((db) =>
            db
                .select({
                    binding: connectorResourceBindingsTable,
                    installation: connectorInstallationsTable,
                    connector: connectorsTable,
                })
                .from(connectorResourceBindingsTable)
                .innerJoin(
                    connectorInstallationsTable,
                    eq(connectorInstallationsTable.id, connectorResourceBindingsTable.connectorInstallationId)
                )
                .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
                .where(eq(connectorResourceBindingsTable.id, bindingId))
                .limit(1)
        );

        if (!row || row.connector.status !== "active" || row.installation.status !== "active") {
            return null;
        }
        if (!isKnownConnectorProvider(row.connector.provider)) {
            return null;
        }

        const connectorCredentials = decryptConnectorCredentials(row.connector.encryptedCredentials, env.AUTH_SECRET);
        if (!isConnectorCredentialsForProvider(connectorCredentials, row.connector.provider)) {
            return null;
        }

        const installationCredentials = readInstallationCredentials(row, row.connector.provider);
        if (!installationCredentials) {
            return null;
        }

        const adapter = yield* createConnectorAdapter({
            provider: row.connector.provider,
            credentials: connectorCredentials,
            installation: installationCredentials,
        });
        return yield* adapter.readFile(connectorFileLocator(row.binding.providerResourceId, metadata));
    });
}

function readInstallationCredentials(
    row: {
        installation: typeof connectorInstallationsTable.$inferSelect;
    },
    provider: ConnectorProvider
): ConnectorInstallationCredentials | null {
    if (provider === "github") {
        return { provider: "github", installationId: row.installation.providerInstallationId };
    }
    if (!row.installation.encryptedCredentials) {
        return null;
    }
    const installationCredentials = decryptConnectorCredentials(row.installation.encryptedCredentials, env.AUTH_SECRET);
    return isInstallationCredentialsForProvider(installationCredentials, provider) ? installationCredentials : null;
}

function connectorFileLocator(resourceId: string, metadata: CompatibleCodeFileMetadata): ConnectorFileLocator {
    return {
        resourceId: metadata.providerResourceId ?? resourceId,
        path: metadata.path,
        ...((metadata.versionId ?? metadata.git?.commitSha)
            ? { versionId: metadata.versionId ?? metadata.git?.commitSha }
            : {}),
        ...(metadata.etag ? { etag: metadata.etag } : {}),
    };
}

function readExternalGitHubFile(url: string): Effect.Effect<string, unknown> {
    return Effect.tryPromise({
        try: async () => {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || parsed.hostname !== "raw.githubusercontent.com") {
                throw new Error("Unsupported external file source");
            }

            const response = await fetch(parsed, { redirect: "manual" });
            const responseUrl = new URL(response.url || parsed.href);
            if (responseUrl.protocol !== "https:" || responseUrl.hostname !== "raw.githubusercontent.com") {
                throw new Error("Unsupported external file source");
            }

            if (!response.ok) {
                throw new Error("External file content not found");
            }

            const contentType = response.headers.get("content-type") ?? "";
            if (!contentType.toLowerCase().startsWith("text/")) {
                throw new Error("External file content is not text");
            }

            const contentLength = response.headers.get("content-length");
            if (contentLength && Number(contentLength) > MAX_CODE_FILE_BYTES) {
                throw new Error("External file content is too large");
            }

            if (!response.body) {
                throw new Error("External file content is empty");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let totalBytes = 0;
            let content = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                totalBytes += value.byteLength;
                if (totalBytes > MAX_CODE_FILE_BYTES) {
                    throw new Error("External file content is too large");
                }

                content += decoder.decode(value, { stream: true });
            }

            content += decoder.decode();
            return content;
        },
        catch: (error) => error,
    });
}
