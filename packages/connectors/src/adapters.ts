import type {
    GitResourceAdapter,
    ConnectorFileLocator,
    ConnectorResource,
    ConnectorResourceDelta,
    ConnectorResourceSnapshot,
    ConnectorResourceVersion,
    ConnectorWebhookHeaders,
    ConnectorWebhookNormalizationOptions,
    ConnectorWebhookVerificationOptions,
    NormalizedWebhookEvent,
    ProviderBranch,
    ProviderRepository,
    ProviderRepositoryClient,
    ProviderRepositoryDelta,
    ProviderRepositorySnapshot,
} from "./types";
import { ConnectorProviderError } from "./types";

export function createGitRepositoryAdapter(options: {
    client: ProviderRepositoryClient;
    verifyWebhook?: (options: ConnectorWebhookVerificationOptions) => boolean;
    normalizeWebhook?: (options: ConnectorWebhookNormalizationOptions) => NormalizedWebhookEvent;
}): GitResourceAdapter {
    const { client } = options;

    return {
        ...client,
        resourceKind: "git-repository",
        async getResource(resourceId) {
            return mapProviderRepositoryToResource(await client.getRepository(resourceId));
        },
        async listResources() {
            return (await client.listRepositories()).map(mapProviderRepositoryToResource);
        },
        async listResourceVersions(resourceId) {
            const repository = await client.getRepository(resourceId);
            return (await client.listBranches(repository)).map((branch) => mapProviderBranchToResourceVersion(resourceId, branch));
        },
        async loadSnapshot(resourceId, versionName, versionId) {
            const repository = await client.getRepository(resourceId);
            return mapProviderRepositorySnapshot(
                await client.loadRepositorySnapshot(repository, versionName, versionId)
            );
        },
        async compareVersions(resourceId, fromVersionId, toVersionId) {
            const repository = await client.getRepository(resourceId);
            return mapProviderRepositoryDelta(await client.compareRepository(repository, fromVersionId, toVersionId));
        },
        async readFile(resourceOrLocator: ConnectorFileLocator | ProviderRepository, path?: string, versionId?: string) {
            if (isProviderRepository(resourceOrLocator)) {
                if (typeof path !== "string" || typeof versionId !== "string") {
                    throw new ConnectorProviderError("validation", "Repository file reads require a path and version ID");
                }
                return client.readFile(resourceOrLocator, path, versionId);
            }

            if (typeof resourceOrLocator.versionId !== "string" || resourceOrLocator.versionId.length === 0) {
                throw new ConnectorProviderError("validation", "Connector file reads require a version ID");
            }

            const repository = await client.getRepository(resourceOrLocator.resourceId);
            return client.readFile(repository, resourceOrLocator.path, resourceOrLocator.versionId);
        },
        verifyWebhook: options.verifyWebhook,
        normalizeWebhook: options.normalizeWebhook,
    };
}

export function mapProviderRepositoryToResource(repository: ProviderRepository): ConnectorResource {
    return {
        provider: repository.provider,
        kind: "git-repository",
        id: repository.id,
        displayName: repository.fullName,
        webUrl: repository.htmlUrl,
        private: repository.private,
        defaultBranch: repository.defaultBranch,
    };
}

export function mapProviderBranchToResourceVersion(resourceId: string, branch: ProviderBranch): ConnectorResourceVersion {
    return {
        resourceId,
        name: branch.name,
        versionId: branch.commitSha,
    };
}

export function mapProviderRepositorySnapshot(snapshot: ProviderRepositorySnapshot): ConnectorResourceSnapshot {
    const version = mapProviderBranchToResourceVersion(snapshot.repository.id, snapshot.branch);

    return {
        resource: {
            ...mapProviderRepositoryToResource(snapshot.repository),
            defaultVersion: version,
        },
        version,
        files: snapshot.files,
    };
}

export function mapProviderRepositoryDelta(delta: ProviderRepositoryDelta): ConnectorResourceDelta {
    return {
        fromVersionId: delta.fromCommitSha,
        toVersionId: delta.toCommitSha,
        isIncremental: delta.isIncremental,
        changes: delta.changes,
    };
}

export function readConnectorWebhookHeader(headers: ConnectorWebhookHeaders, name: string): string | null {
    if (headers instanceof Headers) {
        return headers.get(name);
    }

    const expectedName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === expectedName) {
            return value ?? null;
        }
    }

    return null;
}

function isProviderRepository(value: ConnectorFileLocator | ProviderRepository): value is ProviderRepository {
    return "fullName" in value && "htmlUrl" in value;
}
