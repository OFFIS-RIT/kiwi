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
    getRepository(repositoryId: string): Promise<GitResource>;
    listRepositories(): Promise<GitResource[]>;
    listBranches(repository: GitResource): Promise<GitResourceVersion[]>;
    loadRepositorySnapshot(repository: GitResource, branch: string, commitSha?: string): Promise<GitResourceSnapshot>;
    compareRepository(repository: GitResource, fromCommitSha: string, toCommitSha: string): Promise<GitResourceDelta>;
    readFile(repository: GitResource, path: string, commitSha: string): Promise<string>;
};
export type ProviderRepositoryClient = GitResourceClient;

export type ConnectorAdapter = {
    readonly provider: ConnectorProvider;
    readonly resourceKind: ConnectorResourceKind;
    getResource(resourceId: string): Promise<ConnectorResource>;
    listResources(): Promise<ConnectorResource[]>;
    listResourceVersions(resourceId: string): Promise<ConnectorResourceVersion[]>;
    loadSnapshot(resourceId: string, versionName: string, versionId?: string): Promise<ConnectorResourceSnapshot>;
    compareVersions(resourceId: string, fromVersionId: string, toVersionId: string): Promise<ConnectorResourceDelta>;
    readFile(locator: ConnectorFileLocator): Promise<string>;
    verifyWebhook?(options: ConnectorWebhookVerificationOptions): boolean;
    normalizeWebhook?(options: ConnectorWebhookNormalizationOptions): NormalizedWebhookEvent;
};

export type GitResourceAdapter = ConnectorAdapter & GitResourceClient;
export type GitRepositoryAdapter = GitResourceAdapter;

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
    create(options: ConnectorAdapterFactoryOptions): Promise<ConnectorAdapter>;
    verifyWebhook?(options: ConnectorWebhookVerificationOptions): boolean;
    normalizeWebhook?(options: ConnectorWebhookNormalizationOptions): NormalizedWebhookEvent;
};

export class ConnectorProviderError extends Error {
    constructor(
        public readonly kind: "auth" | "limit" | "not-found" | "provider" | "validation",
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "ConnectorProviderError";
    }
}
