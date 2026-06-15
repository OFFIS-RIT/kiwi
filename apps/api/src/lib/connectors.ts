import { createHmac, timingSafeEqual } from "node:crypto";
import {
    createGitHubClient,
    createGitHubInstallationToken,
    createGitLabClient,
    decryptConnectorCredentials,
    decryptConnectorSecret,
    encryptConnectorCredentials,
    encryptConnectorSecret,
    getGitHubInstallationAccount,
    type ConnectorProvider,
    type ConnectorSecretPayload,
    type GitHubConnectorCredentials,
    type GitLabConnectorCredentials,
    type GitLabInstallationCredentials,
    type ProviderInstallationAccount,
    type ProviderBranch,
    type ProviderRepository,
    type ProviderRepositoryClient,
} from "@kiwi/connectors";
import type { connectorsTable, connectorInstallationsTable } from "@kiwi/db/tables/connectors";
import { env } from "../env";

const frontendUrl =
    env.TRUSTED_ORIGINS?.split(",")
        .map((origin) => origin.trim())
        .find(Boolean) ?? "http://localhost:3000";

const STATE_VERSION = "v1";
const STATE_TTL_MS = 10 * 60 * 1000;

type ConnectorRow = typeof connectorsTable.$inferSelect;
type InstallationRow = typeof connectorInstallationsTable.$inferSelect;

export type ConnectorState = {
    purpose: "github-manifest" | "github-installation" | "gitlab-oauth";
    userId: string;
    connectorId?: string;
    organizationId?: string;
    teamId?: string;
    createdAt: number;
};

export type PublicConnector = {
    id: string;
    provider: ConnectorProvider;
    name: string;
    slug: string;
    status: string;
    appId: string | null;
    clientId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
};

export function toPublicConnector(row: ConnectorRow): PublicConnector {
    return {
        id: row.id,
        provider: row.provider as ConnectorProvider,
        name: row.name,
        slug: row.slug,
        status: row.status,
        appId: row.appId,
        clientId: row.clientId,
        createdAt: row.createdAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null,
    };
}

export function toPublicInstallation(row: InstallationRow) {
    return {
        id: row.id,
        connectorId: row.connectorId,
        provider: row.provider as ConnectorProvider,
        providerInstallationId: row.providerInstallationId,
        providerAccountLogin: row.providerAccountLogin,
        providerAccountType: row.providerAccountType,
        organizationId: row.organizationId,
        teamId: row.teamId,
        repositorySelection: row.repositorySelection,
        status: row.status,
        createdAt: row.createdAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null,
    };
}

export function encryptCredentials(value: ConnectorSecretPayload): string {
    return encryptConnectorCredentials(value, env.AUTH_SECRET);
}

export function encryptSecret(value: string): string {
    return encryptConnectorSecret(value, env.AUTH_SECRET);
}

export function decryptSecret(value: string): string {
    return decryptConnectorSecret(value, env.AUTH_SECRET);
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

export function signConnectorState(state: Omit<ConnectorState, "createdAt">): string {
    const payload = Buffer.from(JSON.stringify({ ...state, createdAt: Date.now() })).toString("base64url");
    const signature = createHmac("sha256", env.AUTH_SECRET).update(payload).digest("base64url");
    return `${STATE_VERSION}.${payload}.${signature}`;
}

export function verifyConnectorState(
    value: string,
    purpose: ConnectorState["purpose"],
    userId?: string
): ConnectorState | null {
    const [version, payload, signature] = value.split(".");
    if (version !== STATE_VERSION || !payload || !signature) {
        return null;
    }

    const expected = createHmac("sha256", env.AUTH_SECRET).update(payload).digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
        return null;
    }

    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConnectorState;
    if (parsed.purpose !== purpose || Date.now() - parsed.createdAt > STATE_TTL_MS) {
        return null;
    }

    if (userId && parsed.userId !== userId) {
        return null;
    }

    return parsed;
}

export function createManifestUrl(state: string, name: string): string {
    const manifest = {
        name,
        url: frontendUrl,
        hook_attributes: {
            url: `${env.API_URL ?? "http://localhost:4321"}/connectors/webhooks/github`,
        },
        redirect_url: `${frontendUrl}/connectors/github/callback`,
        setup_url: `${frontendUrl}/connectors/github/install/callback`,
        public: false,
        default_permissions: {
            contents: "read",
            metadata: "read",
        },
        default_events: ["push", "installation", "installation_repositories"],
    };
    const url = new URL("https://github.com/settings/apps/new");
    url.searchParams.set("state", state);
    url.searchParams.set("manifest", JSON.stringify(manifest));
    return url.href;
}

export async function exchangeGitHubManifestCode(code: string) {
    const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "kiwi-connectors",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });

    if (!response.ok) {
        throw new Error("Invalid connector manifest code");
    }

    return (await response.json()) as {
        id: number | string;
        slug?: string;
        name: string;
        client_id?: string;
        client_secret?: string;
        pem: string;
        webhook_secret?: string;
    };
}

export async function createProviderClient(
    connector: ConnectorRow,
    installation: InstallationRow
): Promise<ProviderRepositoryClient> {
    const credentials = decryptConnectorCredentials(connector.encryptedCredentials, env.AUTH_SECRET);
    if (connector.provider === "github") {
        if (!isGitHubConnectorCredentials(credentials)) {
            throw new Error("Invalid connector credentials");
        }
        const token = await createGitHubInstallationToken({
            credentials,
            installationId: installation.providerInstallationId,
        });
        return createGitHubClient({ installationToken: token.token });
    }

    if (!isGitLabConnectorCredentials(credentials)) {
        throw new Error("Invalid connector credentials");
    }
    const installationCredentials = installation.encryptedCredentials
        ? decryptConnectorCredentials(installation.encryptedCredentials, env.AUTH_SECRET)
        : null;
    if (!installationCredentials || !isGitLabInstallationCredentials(installationCredentials)) {
        throw new Error("Invalid connector installation credentials");
    }
    return createGitLabClient({
        baseUrl: credentials.baseUrl,
        accessToken: installationCredentials.accessToken,
    });
}

export async function getGitHubConnectorInstallationAccount(
    connector: ConnectorRow,
    installationId: string
): Promise<ProviderInstallationAccount> {
    const credentials = decryptConnectorCredentials(connector.encryptedCredentials, env.AUTH_SECRET);
    if (connector.provider !== "github" || !isGitHubConnectorCredentials(credentials)) {
        throw new Error("Invalid connector credentials");
    }

    return getGitHubInstallationAccount({
        credentials,
        installationId,
    });
}

export async function listProviderRepositories(
    connector: ConnectorRow,
    installation: InstallationRow
): Promise<ProviderRepository[]> {
    return (await createProviderClient(connector, installation)).listRepositories();
}

export async function listProviderBranches(
    connector: ConnectorRow,
    installation: InstallationRow,
    repositoryId: string
): Promise<ProviderBranch[]> {
    const client = await createProviderClient(connector, installation);
    const repositories = await client.listRepositories();
    const repository = repositories.find(
        (candidate) => candidate.id === repositoryId || candidate.fullName === repositoryId
    );
    if (!repository) {
        throw new Error("Repository not found");
    }
    return client.listBranches(repository);
}
