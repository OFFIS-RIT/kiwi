import {
    createGitHubClient,
    createGitHubInstallationToken,
    createGitLabClient,
    type GitHubConnectorCredentials,
    type GitLabConnectorCredentials,
    type GitLabInstallationCredentials,
    type ProviderRepository,
} from "@kiwi/connectors";
import { decryptConnectorCredentials, type ConnectorSecretPayload } from "@kiwi/connectors/credentials";
import { db } from "@kiwi/db";
import { connectorInstallationsTable, connectorsTable, repositoryGraphBindingsTable } from "@kiwi/db/tables/connectors";
import { getFile } from "@kiwi/files";
import { eq } from "drizzle-orm";
import { env } from "../env";
import { parseCodeFileMetadata } from "./code-file-metadata";

export type FileContentSource =
    | { kind: "internal"; key: string }
    | { kind: "external"; provider: "github"; url: string; metadata?: string | null }
    | { kind: "connector"; bindingId: string; provider: "github" | "gitlab"; metadata?: string | null };

const MAX_CODE_FILE_BYTES = 2 * 1024 * 1024;

export function fileContentSourceFromRow(row: {
    key: string;
    storageKind?: string | null;
    externalProvider?: string | null;
    externalUrl?: string | null;
    repositoryBindingId?: string | null;
    metadata?: string | null;
}): FileContentSource {
    if (row.storageKind === "external") {
        if (row.repositoryBindingId) {
            if (row.externalProvider !== "github" && row.externalProvider !== "gitlab") {
                throw new Error("Unsupported connector file source");
            }
            return {
                kind: "connector",
                provider: row.externalProvider,
                bindingId: row.repositoryBindingId,
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

export async function readFileContentSource(source: FileContentSource): Promise<string | null> {
    if (source.kind === "internal") {
        const file = await getFile(source.key, env.S3_BUCKET, "text");
        return file?.content ?? null;
    }

    if (source.kind === "connector") {
        return readConnectorFile(source.bindingId, source.metadata);
    }

    return readExternalGitHubFile(source.url);
}

function isGitHubConnectorCredentials(value: ConnectorSecretPayload): value is GitHubConnectorCredentials {
    return "provider" in value && value.provider === "github";
}

function isGitLabConnectorCredentials(value: ConnectorSecretPayload): value is GitLabConnectorCredentials {
    return "provider" in value && value.provider === "gitlab" && "baseUrl" in value;
}

function isGitLabInstallationCredentials(value: ConnectorSecretPayload): value is GitLabInstallationCredentials {
    return "provider" in value && value.provider === "gitlab" && "accessToken" in value;
}

async function readConnectorFile(bindingId: string, metadataValue?: string | null): Promise<string | null> {
    const metadata = parseCodeFileMetadata(metadataValue);
    if (!metadata) {
        return null;
    }

    const [row] = await db
        .select({
            binding: repositoryGraphBindingsTable,
            installation: connectorInstallationsTable,
            connector: connectorsTable,
        })
        .from(repositoryGraphBindingsTable)
        .innerJoin(
            connectorInstallationsTable,
            eq(connectorInstallationsTable.id, repositoryGraphBindingsTable.connectorInstallationId)
        )
        .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
        .where(eq(repositoryGraphBindingsTable.id, bindingId))
        .limit(1);

    if (!row || row.connector.status !== "active" || row.installation.status !== "active") {
        return null;
    }

    const connectorCredentials = decryptConnectorCredentials(row.connector.encryptedCredentials, env.AUTH_SECRET);
    if (row.connector.provider === "github") {
        if (!isGitHubConnectorCredentials(connectorCredentials)) {
            return null;
        }
        const installationToken = await createGitHubInstallationToken({
            credentials: connectorCredentials,
            installationId: row.installation.providerInstallationId,
        });
        const client = createGitHubClient({ installationToken: installationToken.token });
        const repository: ProviderRepository = {
            provider: "github",
            id: row.binding.providerRepositoryId,
            fullName: row.binding.repositoryFullName,
            name: row.binding.repositoryFullName.split("/").at(-1) ?? row.binding.repositoryFullName,
            htmlUrl: row.binding.repositoryHtmlUrl,
            defaultBranch: row.binding.branch,
            private: true,
        };
        return client.readFile(repository, metadata.path, metadata.commitSha);
    }

    if (!isGitLabConnectorCredentials(connectorCredentials)) {
        return null;
    }
    const installationCredentials = row.installation.encryptedCredentials
        ? decryptConnectorCredentials(row.installation.encryptedCredentials, env.AUTH_SECRET)
        : null;
    if (!installationCredentials || !isGitLabInstallationCredentials(installationCredentials)) {
        return null;
    }
    const client = createGitLabClient({
        baseUrl: connectorCredentials.baseUrl,
        accessToken: installationCredentials.accessToken,
    });
    const repository: ProviderRepository = {
        provider: "gitlab",
        id: row.binding.providerRepositoryId,
        fullName: row.binding.repositoryFullName,
        name: row.binding.repositoryFullName.split("/").at(-1) ?? row.binding.repositoryFullName,
        htmlUrl: row.binding.repositoryHtmlUrl,
        defaultBranch: row.binding.branch,
        private: true,
    };
    return client.readFile(repository, metadata.path, metadata.commitSha);
}

async function readExternalGitHubFile(url: string): Promise<string> {
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
}
