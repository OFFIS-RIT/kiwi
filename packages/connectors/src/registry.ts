import {
    createGitHubClient,
    createGitHubInstallationToken,
    normalizeGitHubWebhookEvent,
    verifyGitHubWebhookSignature,
} from "./github";
import {
    createGitLabClient,
    normalizeGitLabBaseUrl,
    normalizeGitLabWebhookEvent,
    verifyGitLabWebhookToken,
} from "./gitlab";
import type {
    ConnectorAdapter,
    ConnectorAdapterFactoryOptions,
    ConnectorAdapterRegistryEntry,
    ConnectorCredentials,
    ConnectorInstallationCredentials,
    ConnectorProvider,
    GitHubConnectorCredentials,
    GitHubInstallationCredentials,
    GitLabConnectorCredentials,
    GitLabInstallationCredentials,
    NormalizedWebhookEvent,
} from "./types";
import { ConnectorProviderError } from "./types";
import { readConnectorWebhookHeader } from "./adapters";

export const connectorAdapterRegistry: Record<ConnectorProvider, ConnectorAdapterRegistryEntry> = {
    github: {
        provider: "github",
        resourceKind: "git-repository",
        async create(options) {
            const credentials = requireGitHubConnectorCredentials(options.provider, options.credentials);
            const installation = requireGitHubInstallationCredentials(options.provider, options.installation);
            const token = await createGitHubInstallationToken({
                credentials,
                installationId: installation.installationId,
                apiBaseUrl: options.apiBaseUrl,
                fetch: options.fetch,
            });

            return createGitHubClient({
                installationToken: token.token,
                apiBaseUrl: options.apiBaseUrl,
                fetch: options.fetch,
            });
        },
        verifyWebhook(options) {
            return verifyGitHubWebhookSignature({
                body: options.body,
                webhookSecret: options.webhookSecret,
                signatureHeader: readConnectorWebhookHeader(options.headers, "x-hub-signature-256"),
            });
        },
        normalizeWebhook(options) {
            return normalizeGitHubWebhookEvent(options);
        },
    },
    gitlab: {
        provider: "gitlab",
        resourceKind: "git-repository",
        async create(options) {
            const credentials = requireGitLabConnectorCredentials(options.provider, options.credentials);
            const installation = requireGitLabInstallationCredentials(options.provider, options.installation);

            return createGitLabClient({
                baseUrl: normalizeGitLabBaseUrl(credentials.baseUrl),
                accessToken: installation.accessToken,
                fetch: options.fetch,
            });
        },
        verifyWebhook(options) {
            return verifyGitLabWebhookToken({
                webhookSecret: options.webhookSecret,
                tokenHeader: readConnectorWebhookHeader(options.headers, "x-gitlab-token"),
            });
        },
        normalizeWebhook(options) {
            return normalizeGitLabWebhookEvent(options);
        },
    },
};

export function getConnectorAdapterRegistryEntry(provider: ConnectorProvider): ConnectorAdapterRegistryEntry {
    return connectorAdapterRegistry[provider];
}

export async function createConnectorAdapter(options: ConnectorAdapterFactoryOptions): Promise<ConnectorAdapter> {
    return connectorAdapterRegistry[options.provider].create(options);
}

export function verifyConnectorWebhook(
    provider: ConnectorProvider,
    options: Parameters<NonNullable<ConnectorAdapterRegistryEntry["verifyWebhook"]>>[0]
): boolean {
    const verifyWebhook = connectorAdapterRegistry[provider].verifyWebhook;
    if (!verifyWebhook) {
        throw new ConnectorProviderError("validation", `Provider ${provider} does not support webhook verification`);
    }

    return verifyWebhook(options);
}

export function normalizeConnectorWebhook(
    provider: ConnectorProvider,
    options: Parameters<NonNullable<ConnectorAdapterRegistryEntry["normalizeWebhook"]>>[0]
): NormalizedWebhookEvent {
    const normalizeWebhook = connectorAdapterRegistry[provider].normalizeWebhook;
    if (!normalizeWebhook) {
        throw new ConnectorProviderError("validation", `Provider ${provider} does not support webhook normalization`);
    }

    return normalizeWebhook(options);
}

function requireGitHubConnectorCredentials(
    provider: ConnectorProvider,
    credentials: ConnectorCredentials
): GitHubConnectorCredentials {
    if (provider === "github" && credentials.provider === "github") {
        return credentials;
    }

    throw new ConnectorProviderError("validation", "GitHub connector credentials are required for this provider");
}

function requireGitHubInstallationCredentials(
    provider: ConnectorProvider,
    installation: ConnectorInstallationCredentials
): GitHubInstallationCredentials {
    if (provider === "github" && installation.provider === "github") {
        return installation;
    }

    throw new ConnectorProviderError("validation", "GitHub installation credentials are required for this provider");
}

function requireGitLabConnectorCredentials(
    provider: ConnectorProvider,
    credentials: ConnectorCredentials
): GitLabConnectorCredentials {
    if (provider === "gitlab" && credentials.provider === "gitlab") {
        return credentials;
    }

    throw new ConnectorProviderError("validation", "GitLab connector credentials are required for this provider");
}

function requireGitLabInstallationCredentials(
    provider: ConnectorProvider,
    installation: ConnectorInstallationCredentials
): GitLabInstallationCredentials {
    if (provider === "gitlab" && installation.provider === "gitlab") {
        return installation;
    }

    throw new ConnectorProviderError("validation", "GitLab installation credentials are required for this provider");
}
