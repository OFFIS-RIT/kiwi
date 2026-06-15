export type ConnectorProvider = "github" | "gitlab";

export type ProviderRepository = {
    provider: ConnectorProvider;
    id: string;
    fullName: string;
    name: string;
    htmlUrl: string;
    defaultBranch: string | null;
    private: boolean;
};

export type ProviderBranch = {
    name: string;
    commitSha: string;
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

export type ProviderRepositorySnapshot = {
    repository: ProviderRepository;
    branch: ProviderBranch;
    commitSha: string;
    files: ProviderCodeFile[];
};
export type ProviderRepositoryChange =
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

export type ProviderRepositoryDelta = {
    fromCommitSha: string;
    toCommitSha: string;
    isIncremental: boolean;
    changes: ProviderRepositoryChange[];
};

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
    repositoryId: string | null;
    repositoryFullName: string | null;
    branch: string | null;
    commitSha: string | null;
    installationId?: string;
    raw: unknown;
};

export type ProviderRepositoryClient = {
    readonly provider: ConnectorProvider;
    listRepositories(): Promise<ProviderRepository[]>;
    listBranches(repository: ProviderRepository): Promise<ProviderBranch[]>;
    loadRepositorySnapshot(
        repository: ProviderRepository,
        branch: string,
        commitSha?: string
    ): Promise<ProviderRepositorySnapshot>;
    compareRepository(
        repository: ProviderRepository,
        fromCommitSha: string,
        toCommitSha: string
    ): Promise<ProviderRepositoryDelta>;
    readFile(repository: ProviderRepository, path: string, commitSha: string): Promise<string>;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
