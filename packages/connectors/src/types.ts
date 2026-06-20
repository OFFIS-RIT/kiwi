import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export type ConnectorProvider = "github" | "gitlab";

export type ConnectorResourceKind = "git-repository" | "folder";

export type GitResource = {
    provider: ConnectorProvider;
    id: string;
    fullName: string;
    name: string;
    htmlUrl: string;
    defaultBranch: string | null;
    private: boolean;
};
export type ProviderRepository = GitResource;

export type GitResourceVersion = {
    name: string;
    commitSha: string;
};
export type ProviderBranch = GitResourceVersion;

export type ConnectorResource = {
    provider: ConnectorProvider;
    kind: ConnectorResourceKind;
    id: string;
    displayName: string;
    webUrl: string;
    private: boolean;
    defaultVersion?: ConnectorResourceVersion | null;
    defaultBranch?: string | null;
};

export type ConnectorResourceVersion = {
    resourceId: string;
    name: string;
    versionId: string;
};

export type ConnectorFileLocator = {
    resourceId: string;
    path: string;
    versionId?: string;
    etag?: string;
};

export type ConnectorResourceSnapshot = {
    resource: ConnectorResource;
    version: ConnectorResourceVersion;
    files: ProviderCodeFile[];
};

export type ConnectorResourceChange =
    | {
          status: "added" | "modified";
          newPath: string;
      }
    | {
          status: "deleted";
          oldPath: string;
      }
    | {
          status: "renamed";
          oldPath: string;
          newPath: string;
      };

export type ConnectorResourceDelta = {
    fromVersionId: string;
    toVersionId: string;
    isIncremental: boolean;
    changes: ConnectorResourceChange[];
};

export type ProviderInstallationAccount = {
    login: string;
    type: "user" | "organization" | "group" | null;
    repositorySelection: "all" | "selected" | "unknown";
};

export type ProviderCodeFile = {
    path: string;
    size: number;
    checksum: string;
    htmlUrl: string;
    rawUrl?: string;
    content: string;
};

export type GitResourceSnapshot = {
    repository: GitResource;
    branch: GitResourceVersion;
    commitSha: string;
    files: ProviderCodeFile[];
};
export type ProviderRepositorySnapshot = GitResourceSnapshot;

export type GitResourceChange =
    | {
          status: "added" | "modified";
          newPath: string;
      }
    | {
          status: "deleted";
          oldPath: string;
      }
    | {
          status: "renamed";
          oldPath: string;
          newPath: string;
      };
export type ProviderRepositoryChange = GitResourceChange;

export type GitResourceDelta = {
    fromCommitSha: string;
    toCommitSha: string;
    isIncremental: boolean;
    changes: GitResourceChange[];
};
export type ProviderRepositoryDelta = GitResourceDelta;

export type ConnectorCredentials = GitHubConnectorCredentials | GitLabConnectorCredentials;

export type ConnectorInstallationCredentials = GitHubInstallationCredentials | GitLabInstallationCredentials;

export type GitHubConnectorCredentials = {
    provider: "github";
    appId: string;
    privateKeyPem: string;
    clientId?: string;
    clientSecret?: string;
    webhookSecret?: string;
};

export type GitHubInstallationCredentials = {
    provider: "github";
    installationId: string;
};

export type GitLabConnectorCredentials = {
    provider: "gitlab";
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    webhookSecret?: string;
};

export type GitLabInstallationCredentials = {
    provider: "gitlab";
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
};

export type NormalizedWebhookEvent = {
    provider: ConnectorProvider;
    deliveryId: string;
    eventName: string;
    resourceKind: ConnectorResourceKind;
    resourceId: string | null;
    resourceDisplayName: string | null;
    resourceName: string | null;
    versionName: string | null;
    versionId: string | null;
    repositoryId: string | null;
    repositoryFullName: string | null;
    branch: string | null;
    commitSha: string | null;
    installationId?: string;
    raw: unknown;
};

export type ConnectorWebhookHeaders = Headers | Record<string, string | null | undefined>;

export type ConnectorWebhookVerificationOptions = {
    body: string | Buffer | Uint8Array;
    headers: ConnectorWebhookHeaders;
    webhookSecret: string;
};

export type ConnectorWebhookNormalizationOptions = {
    eventName: string;
    deliveryId: string;
    payload: unknown;
};

export type GitResourceClient = {
    readonly provider: ConnectorProvider;
    getRepository(repositoryId: string): Effect.Effect<GitResource, ConnectorProviderError>;
    listRepositories(): Effect.Effect<GitResource[], ConnectorProviderError>;
    listBranches(repository: GitResource): Effect.Effect<GitResourceVersion[], ConnectorProviderError>;
    loadRepositorySnapshot(
        repository: GitResource,
        branch: string,
        commitSha?: string
    ): Effect.Effect<GitResourceSnapshot, ConnectorProviderError>;
    compareRepository(
        repository: GitResource,
        fromCommitSha: string,
        toCommitSha: string
    ): Effect.Effect<GitResourceDelta, ConnectorProviderError>;
    readFile(repository: GitResource, path: string, commitSha: string): Effect.Effect<string, ConnectorProviderError>;
};
export type ProviderRepositoryClient = GitResourceClient;

export type ConnectorAdapter = {
    readonly provider: ConnectorProvider;
    readonly resourceKind: ConnectorResourceKind;
    readonly capabilities?: ConnectorResourceCapabilities;
    getResource(resourceId: string): Effect.Effect<ConnectorResource, ConnectorProviderError>;
    listResources(): Effect.Effect<ConnectorResource[], ConnectorProviderError>;
    listResourceVersions(resourceId: string): Effect.Effect<ConnectorResourceVersion[], ConnectorProviderError>;
    loadSnapshot(
        resourceId: string,
        versionName: string,
        versionId?: string
    ): Effect.Effect<ConnectorResourceSnapshot, ConnectorProviderError>;
    compareVersions(
        resourceId: string,
        fromVersionId: string,
        toVersionId: string
    ): Effect.Effect<ConnectorResourceDelta, ConnectorProviderError>;
    readFile(locator: ConnectorFileLocator): Effect.Effect<string, ConnectorProviderError>;
    // Optional, capability-gated operations. Implemented by storage-style adapters; git
    // adapters leave them undefined and advertise the gap via `capabilities`.
    listChildren?(parentId?: string): Effect.Effect<ConnectorResourceChild[], ConnectorProviderError>;
    listChanges?(
        resourceId: string,
        cursor?: string
    ): Effect.Effect<ConnectorResourceChangeSet, ConnectorProviderError>;
    openFile?(locator: ConnectorFileLocator): Effect.Effect<ConnectorBinaryFile, ConnectorProviderError>;
    verifyWebhook?(options: ConnectorWebhookVerificationOptions): boolean;
    normalizeWebhook?(options: ConnectorWebhookNormalizationOptions): NormalizedWebhookEvent;
};

export type GitResourceAdapter = ConnectorAdapter & GitResourceClient;
export type GitRepositoryAdapter = GitResourceAdapter;

// Declares which optional capabilities an adapter supports so callers can branch on
// behaviour without provider-specific knowledge. Git adapters expose named versions
// and version-range compares; flat cloud storages expose cursor sync, browse and
// binary reads instead.
export type ConnectorResourceCapabilities = {
    // Named, listable versions (git branches). False for storages with no version axis.
    versions: boolean;
    // Cursor-based incremental sync via listChanges (Dropbox/SharePoint delta tokens).
    cursorSync: boolean;
    // Hierarchical browse via listChildren (drives/folders).
    children: boolean;
    // Binary-capable reads via openFile for non-text content (PDF, office docs, images).
    binaryFiles: boolean;
};

// A child entry when browsing a hierarchical resource, generic over git tree entries
// and cloud-storage folders/files.
export type ConnectorResourceChild = {
    id: string;
    parentId: string | null;
    name: string;
    path: string;
    kind: "folder" | "file";
    webUrl?: string;
    size?: number;
    versionId?: string;
};

// Cursor-based change set: the storage-native delta shape. Git adapters can derive this
// from compareVersions; storage adapters return it directly from their delta endpoint.
export type ConnectorResourceChangeSet = {
    changes: ConnectorResourceChange[];
    cursor: string;
    isInitial: boolean;
};

// Binary-capable file read for non-text resources. Bytes are fetched on demand for
// processing and never persisted by the connector layer.
export type ConnectorBinaryFile = {
    locator: ConnectorFileLocator;
    bytes: Uint8Array;
    size: number;
    contentType?: string;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ConnectorAdapterFactoryOptions = {
    provider: ConnectorProvider;
    credentials: ConnectorCredentials;
    installation: ConnectorInstallationCredentials;
    apiBaseUrl?: string;
    fetch?: FetchLike;
};

export type ConnectorAdapterRegistryEntry = {
    provider: ConnectorProvider;
    resourceKind: ConnectorResourceKind;
    create(options: ConnectorAdapterFactoryOptions): Effect.Effect<ConnectorAdapter, ConnectorProviderError>;
    // Structural validation of this provider's connector- and installation-credential
    // shapes. Lets credential encryption stay provider-agnostic: new providers register
    // their validators here instead of editing the shared credentials module.
    validateCredentials?(value: Record<string, unknown>): boolean;
    validateInstallation?(value: Record<string, unknown>): boolean;
    verifyWebhook?(options: ConnectorWebhookVerificationOptions): boolean;
    normalizeWebhook?(options: ConnectorWebhookNormalizationOptions): NormalizedWebhookEvent;
};

const CONNECTOR_PROVIDER_ERROR_KINDS = ["auth", "limit", "not-found", "provider", "validation"] as const;
export type ConnectorProviderErrorKind = (typeof CONNECTOR_PROVIDER_ERROR_KINDS)[number];

export class ConnectorProviderError extends Schema.TaggedErrorClass<ConnectorProviderError>()(
    "ConnectorProviderError",
    {
        kind: Schema.Literals(CONNECTOR_PROVIDER_ERROR_KINDS),
        message: Schema.String,
        cause: Schema.optional(Schema.Unknown),
    }
) {
    constructor(kind: ConnectorProviderErrorKind, message: string, options?: { cause?: unknown }) {
        super(options?.cause === undefined ? { kind, message } : { kind, message, cause: options.cause });
    }
}
