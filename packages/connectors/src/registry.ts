import * as Effect from "effect/Effect";

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
import {
    createNextcloudAdapter,
    NEXTCLOUD_PROVIDER,
    NEXTCLOUD_RESOURCE_CAPABILITIES,
    nextcloudCredentialDescriptors,
} from "./nextcloud";
import {
    createSharePointAdapter,
    SHAREPOINT_PROVIDER,
    SHAREPOINT_RESOURCE_CAPABILITIES,
    sharepointCredentialDescriptors,
} from "./sharepoint";
import type {
    ConnectorAdapter,
    ConnectorAdapterFactoryOptions,
    ConnectorAdapterRegistryEntry,
    ConnectorCredentialDescriptors,
    ConnectorCredentialPayloadData,
    ConnectorCredentialSubject,
    ConnectorCredentials,
    ConnectorInstallationCredentials,
    ConnectorProvider,
    ConnectorProviderDisplay,
    ConnectorResourceCapabilities,
    GitHubConnectorCredentials,
    GitHubInstallationCredentials,
    GitLabConnectorCredentials,
    GitLabInstallationCredentials,
    NormalizedWebhookEvent,
    VersionedConnectorCredentialPayload,
} from "./types";
import { ConnectorProviderError, NO_SYNC_CONNECTOR_RESOURCE_CAPABILITIES } from "./types";
import { readConnectorWebhookHeader } from "./adapters";

const GIT_RESOURCE_CAPABILITIES: ConnectorResourceCapabilities = {
    versions: true,
    cursorSync: false,
    children: false,
    binaryFiles: false,
};

const gitHubCredentialDescriptors = {
    app: {
        subject: "app",
        version: "v1",
        validate: isGitHubConnectorCredentialData,
    },
    installation: {
        subject: "installation",
        version: "v1",
        validate: isGitHubInstallationCredentialData,
    },
} satisfies Required<ConnectorCredentialDescriptors>;

const gitLabCredentialDescriptors = {
    app: {
        subject: "app",
        version: "v1",
        validate: isGitLabConnectorCredentialData,
    },
    installation: {
        subject: "installation",
        version: "v1",
        validate: isGitLabInstallationCredentialData,
    },
} satisfies Required<ConnectorCredentialDescriptors>;

const builtInConnectorAdapterRegistry = {
    github: withDefaultCredentialValidators({
        provider: "github",
        family: "resource-source",
        display: {
            name: "GitHub",
            description: "GitHub App repository source",
            docsUrl: "https://docs.github.com/apps",
        },
        resourceKind: "git-repository",
        capabilities: GIT_RESOURCE_CAPABILITIES,
        setup: [
            {
                kind: "manifest",
                label: "GitHub App manifest",
                description: "Create a GitHub App from a generated manifest.",
            },
        ],
        install: [
            {
                kind: "externalRedirect",
                label: "GitHub App installation",
                description: "Send the installing user to GitHub's app installation flow.",
            },
        ],
        credentialDescriptors: gitHubCredentialDescriptors,
        create: Effect.fn("ConnectorRegistry.github.create")(function* (options: ConnectorAdapterFactoryOptions) {
            const credentials = yield* Effect.try({
                try: () => requireGitHubConnectorCredentials(options.provider, options.credentials),
                catch: toConnectorProviderError,
            });
            const installation = yield* Effect.try({
                try: () => requireGitHubInstallationCredentials(options.provider, options.installation),
                catch: toConnectorProviderError,
            });
            const token = yield* createGitHubInstallationToken({
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
        }),
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
    }),
    gitlab: withDefaultCredentialValidators({
        provider: "gitlab",
        family: "resource-source",
        display: {
            name: "GitLab",
            description: "GitLab project source",
            docsUrl: "https://docs.gitlab.com/integration/oauth_provider/",
        },
        resourceKind: "git-repository",
        capabilities: GIT_RESOURCE_CAPABILITIES,
        setup: [
            {
                kind: "manualCredentials",
                label: "GitLab OAuth application",
                description: "Register a GitLab OAuth application and paste the client credentials.",
            },
        ],
        install: [
            {
                kind: "oauth",
                label: "GitLab OAuth authorization",
                description: "Authorize the registered GitLab application for a user or group.",
            },
        ],
        credentialDescriptors: gitLabCredentialDescriptors,
        create: Effect.fn("ConnectorRegistry.gitlab.create")(function* (options: ConnectorAdapterFactoryOptions) {
            const credentials = yield* Effect.try({
                try: () => requireGitLabConnectorCredentials(options.provider, options.credentials),
                catch: toConnectorProviderError,
            });
            const installation = yield* Effect.try({
                try: () => requireGitLabInstallationCredentials(options.provider, options.installation),
                catch: toConnectorProviderError,
            });

            return createGitLabClient({
                baseUrl: normalizeGitLabBaseUrl(credentials.baseUrl),
                accessToken: installation.accessToken,
                fetch: options.fetch,
            });
        }),
        verifyWebhook(options) {
            return verifyGitLabWebhookToken({
                webhookSecret: options.webhookSecret,
                tokenHeader: readConnectorWebhookHeader(options.headers, "x-gitlab-token"),
            });
        },
        normalizeWebhook(options) {
            return normalizeGitLabWebhookEvent(options);
        },
    }),
    [NEXTCLOUD_PROVIDER]: withDefaultCredentialValidators({
        provider: NEXTCLOUD_PROVIDER,
        family: "resource-source",
        display: {
            name: "Nextcloud",
            description: "Nextcloud WebDAV folder source",
            docsUrl: "https://docs.nextcloud.com/server/latest/developer_manual/client_apis/WebDAV/basic.html",
        },
        resourceKind: "folder",
        capabilities: NEXTCLOUD_RESOURCE_CAPABILITIES,
        setup: [
            {
                kind: "manualCredentials",
                label: "Nextcloud server",
                description: "Register the Nextcloud server URL used for WebDAV file access.",
            },
        ],
        install: [
            {
                kind: "manualActivation",
                label: "Nextcloud folder",
                description: "Store an app-password credential and folder path for the team or organization.",
            },
        ],
        credentialDescriptors: nextcloudCredentialDescriptors,
        create: Effect.fn("ConnectorRegistry.nextcloud.create")(function* (options: ConnectorAdapterFactoryOptions) {
            const credentials = yield* Effect.try({
                try: () => requireConnectorCredentialData(options.provider, "app", options.credentials),
                catch: toConnectorProviderError,
            });
            const installation = yield* Effect.try({
                try: () => requireConnectorCredentialData(options.provider, "installation", options.installation),
                catch: toConnectorProviderError,
            });
            return yield* Effect.try({
                try: () =>
                    createNextcloudAdapter({
                        baseUrl: credentials.baseUrl as string,
                        username: installation.username as string,
                        appPassword: installation.appPassword as string,
                        folderPath: installation.folderPath as string,
                        fetch: options.fetch,
                    }),
                catch: toConnectorProviderError,
            });
        }),
    }),
    [SHAREPOINT_PROVIDER]: withDefaultCredentialValidators({
        provider: SHAREPOINT_PROVIDER,
        family: "resource-source",
        display: {
            name: "SharePoint",
            description: "Microsoft Graph SharePoint document library source",
            docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/driveitem",
        },
        resourceKind: "folder",
        capabilities: SHAREPOINT_RESOURCE_CAPABILITIES,
        setup: [
            {
                kind: "manualCredentials",
                label: "Microsoft Graph application",
                description:
                    "Store the tenant ID, client ID, and client secret used for application-permission Graph access.",
            },
        ],
        install: [
            {
                kind: "manualActivation",
                label: "SharePoint folder",
                description: "Store a site, drive, and folder path for team or organization access.",
            },
        ],
        credentialDescriptors: sharepointCredentialDescriptors,
        create: Effect.fn("ConnectorRegistry.sharepoint.create")(function* (options: ConnectorAdapterFactoryOptions) {
            const credentials = yield* Effect.try({
                try: () => requireConnectorCredentialData(options.provider, "app", options.credentials),
                catch: toConnectorProviderError,
            });
            const installation = yield* Effect.try({
                try: () => requireConnectorCredentialData(options.provider, "installation", options.installation),
                catch: toConnectorProviderError,
            });
            return yield* Effect.try({
                try: () =>
                    createSharePointAdapter({
                        tenantId: credentials.tenantId as string,
                        clientId: credentials.clientId as string,
                        clientSecret: credentials.clientSecret as string,
                        siteId: installation.siteId as string,
                        driveId: installation.driveId as string,
                        folderPath: installation.folderPath as string,
                        folderId: installation.folderId as string | undefined,
                        fetch: options.fetch,
                    }),
                catch: toConnectorProviderError,
            });
        }),
    }),
} satisfies Record<string, ConnectorAdapterRegistryEntry>;

export const connectorAdapterRegistry: Record<ConnectorProvider, ConnectorAdapterRegistryEntry> = {
    ...builtInConnectorAdapterRegistry,
};

export function registerConnectorAdapter(entry: ConnectorAdapterRegistryEntry): ConnectorAdapterRegistryEntry {
    const normalized = withDefaultCredentialValidators(entry);
    connectorAdapterRegistry[normalized.provider] = normalized;
    return normalized;
}

export function createChatBotConnectorRegistryEntry(options: {
    provider: ConnectorProvider;
    display: ConnectorProviderDisplay;
    setup?: readonly ConnectorAdapterRegistryEntry["setup"][number][];
    install?: readonly ConnectorAdapterRegistryEntry["install"][number][];
    credentialDescriptors: ConnectorCredentialDescriptors;
}): ConnectorAdapterRegistryEntry {
    return withDefaultCredentialValidators({
        provider: options.provider,
        family: "chat-bot",
        display: options.display,
        capabilities: NO_SYNC_CONNECTOR_RESOURCE_CAPABILITIES,
        setup: options.setup ?? [
            {
                kind: "oauthApp",
                label: "Bot OAuth app",
                description: "Register the bot app with the chat provider.",
            },
        ],
        install: options.install ?? [
            {
                kind: "botInstall",
                label: "Install bot",
                description: "Install the bot into the target workspace or organization.",
            },
            {
                kind: "oauth",
                label: "Authorize bot",
                description: "Complete the provider OAuth flow for bot credentials.",
            },
        ],
        credentialDescriptors: options.credentialDescriptors,
    });
}

export function getConnectorAdapterRegistryEntry(provider: ConnectorProvider): ConnectorAdapterRegistryEntry {
    const entry = connectorAdapterRegistry[provider];
    if (!entry) {
        throw new ConnectorProviderError("validation", `Provider ${provider} is not registered`);
    }
    return entry;
}

export function listConnectorAdapterRegistryEntries(): ConnectorAdapterRegistryEntry[] {
    return Object.values(connectorAdapterRegistry);
}

export function isKnownConnectorProvider(value: string): value is ConnectorProvider {
    return Object.prototype.hasOwnProperty.call(connectorAdapterRegistry, value);
}

export const createConnectorAdapter: (
    options: ConnectorAdapterFactoryOptions
) => Effect.Effect<ConnectorAdapter, ConnectorProviderError> = Effect.fn("createConnectorAdapter")(function* (
    options: ConnectorAdapterFactoryOptions
) {
    const entry = connectorAdapterRegistry[options.provider];
    if (!entry) {
        return yield* Effect.fail(
            new ConnectorProviderError("validation", `Provider ${options.provider} is not registered`)
        );
    }
    if ((entry.family ?? "resource-source") !== "resource-source" || !entry.create) {
        return yield* Effect.fail(
            new ConnectorProviderError("validation", `Provider ${options.provider} does not create resource adapters`)
        );
    }
    return yield* entry.create(options);
});

export function verifyConnectorWebhook(
    provider: ConnectorProvider,
    options: Parameters<NonNullable<ConnectorAdapterRegistryEntry["verifyWebhook"]>>[0]
): boolean {
    const verifyWebhook = getConnectorAdapterRegistryEntry(provider).verifyWebhook;
    if (!verifyWebhook) {
        throw new ConnectorProviderError("validation", `Provider ${provider} does not support webhook verification`);
    }

    return verifyWebhook(options);
}

export function normalizeConnectorWebhook(
    provider: ConnectorProvider,
    options: Parameters<NonNullable<ConnectorAdapterRegistryEntry["normalizeWebhook"]>>[0]
): NormalizedWebhookEvent {
    const normalizeWebhook = getConnectorAdapterRegistryEntry(provider).normalizeWebhook;
    if (!normalizeWebhook) {
        throw new ConnectorProviderError("validation", `Provider ${provider} does not support webhook normalization`);
    }

    return normalizeWebhook(options);
}

function withDefaultCredentialValidators(entry: ConnectorAdapterRegistryEntry): ConnectorAdapterRegistryEntry {
    return {
        ...entry,
        validateCredentials: entry.validateCredentials ?? ((value) => validateCredentialPayload(entry, "app", value)),
        validateInstallation:
            entry.validateInstallation ?? ((value) => validateCredentialPayload(entry, "installation", value)),
    };
}

function validateCredentialPayload(
    entry: ConnectorAdapterRegistryEntry,
    subject: ConnectorCredentialSubject,
    value: Record<string, unknown>
): boolean {
    const descriptor = entry.credentialDescriptors[subject];
    if (!descriptor) {
        return false;
    }

    if (isVersionedConnectorCredentialPayload(value)) {
        return (
            value.provider === entry.provider &&
            value.subject === subject &&
            value.version === descriptor.version &&
            descriptor.validate(value.data)
        );
    }

    return value.provider === entry.provider && descriptor.validate(value);
}

function requireConnectorCredentialData(
    provider: ConnectorProvider,
    subject: ConnectorCredentialSubject,
    value: ConnectorCredentials | ConnectorInstallationCredentials
): ConnectorCredentialPayloadData {
    const entry = getConnectorAdapterRegistryEntry(provider);
    const descriptor = entry.credentialDescriptors[subject];
    if (!descriptor) {
        throw new ConnectorProviderError("validation", `Provider ${provider} does not accept ${subject} credentials`);
    }

    if (!isObject(value)) {
        throw new ConnectorProviderError("validation", "Connector credentials must be an object");
    }

    if (isVersionedConnectorCredentialPayload(value)) {
        if (
            value.provider === provider &&
            value.subject === subject &&
            value.version === descriptor.version &&
            descriptor.validate(value.data)
        ) {
            return value.data;
        }
        throw new ConnectorProviderError("validation", `Provider ${provider} ${subject} credentials are invalid`);
    }

    if (value.provider === provider && descriptor.validate(value)) {
        return value;
    }

    throw new ConnectorProviderError("validation", `Provider ${provider} ${subject} credentials are invalid`);
}

function isVersionedConnectorCredentialPayload(
    value: Record<string, unknown>
): value is VersionedConnectorCredentialPayload {
    return (
        typeof value.provider === "string" &&
        typeof value.subject === "string" &&
        typeof value.version === "string" &&
        isObject(value.data)
    );
}

function toConnectorProviderError(error: unknown): ConnectorProviderError {
    return error instanceof ConnectorProviderError
        ? error
        : new ConnectorProviderError("validation", "Connector configuration is invalid", { cause: error });
}

function requireGitHubConnectorCredentials(
    provider: ConnectorProvider,
    credentials: ConnectorCredentials
): GitHubConnectorCredentials {
    if (provider !== "github") {
        throw new ConnectorProviderError("validation", "GitHub connector credentials are required for this provider");
    }
    const data = requireConnectorCredentialData(provider, "app", credentials);
    return {
        provider: "github",
        appId: data.appId as string,
        privateKeyPem: data.privateKeyPem as string,
        clientId: optionalString(data, "clientId"),
        clientSecret: optionalString(data, "clientSecret"),
        webhookSecret: optionalString(data, "webhookSecret"),
    };
}

function requireGitHubInstallationCredentials(
    provider: ConnectorProvider,
    installation: ConnectorInstallationCredentials
): GitHubInstallationCredentials {
    if (provider !== "github") {
        throw new ConnectorProviderError(
            "validation",
            "GitHub installation credentials are required for this provider"
        );
    }
    const data = requireConnectorCredentialData(provider, "installation", installation);
    return {
        provider: "github",
        installationId: data.installationId as string,
    };
}

function requireGitLabConnectorCredentials(
    provider: ConnectorProvider,
    credentials: ConnectorCredentials
): GitLabConnectorCredentials {
    if (provider !== "gitlab") {
        throw new ConnectorProviderError("validation", "GitLab connector credentials are required for this provider");
    }
    const data = requireConnectorCredentialData(provider, "app", credentials);
    return {
        provider: "gitlab",
        baseUrl: data.baseUrl as string,
        clientId: data.clientId as string,
        clientSecret: data.clientSecret as string,
        webhookSecret: optionalString(data, "webhookSecret"),
    };
}

function requireGitLabInstallationCredentials(
    provider: ConnectorProvider,
    installation: ConnectorInstallationCredentials
): GitLabInstallationCredentials {
    if (provider !== "gitlab") {
        throw new ConnectorProviderError(
            "validation",
            "GitLab installation credentials are required for this provider"
        );
    }
    const data = requireConnectorCredentialData(provider, "installation", installation);
    return {
        provider: "gitlab",
        accessToken: data.accessToken as string,
        refreshToken: optionalString(data, "refreshToken"),
        expiresAt: optionalString(data, "expiresAt"),
    };
}

function isGitHubConnectorCredentialData(value: ConnectorCredentialPayloadData): boolean {
    return hasNonEmptyString(value, "appId") && hasNonEmptyString(value, "privateKeyPem")
        ? isOptionalString(value, "clientId") &&
              isOptionalString(value, "clientSecret") &&
              isOptionalString(value, "webhookSecret")
        : false;
}

function isGitHubInstallationCredentialData(value: ConnectorCredentialPayloadData): boolean {
    return hasNonEmptyString(value, "installationId");
}

function isGitLabConnectorCredentialData(value: ConnectorCredentialPayloadData): boolean {
    return hasNonEmptyString(value, "baseUrl") &&
        hasNonEmptyString(value, "clientId") &&
        hasNonEmptyString(value, "clientSecret")
        ? isOptionalString(value, "webhookSecret")
        : false;
}

function isGitLabInstallationCredentialData(value: ConnectorCredentialPayloadData): boolean {
    return hasNonEmptyString(value, "accessToken")
        ? isOptionalString(value, "refreshToken") && isOptionalString(value, "expiresAt")
        : false;
}

function hasNonEmptyString(value: Record<string, unknown>, key: string): boolean {
    return typeof value[key] === "string" && (value[key] as string).trim().length > 0;
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
    return value[key] === undefined || typeof value[key] === "string";
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
    return typeof value[key] === "string" ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
