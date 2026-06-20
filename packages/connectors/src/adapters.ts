import * as Effect from "effect/Effect";

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
        // Git exposes named branch versions and version-range compares; it does not browse
        // children, sync by cursor, or read binary blobs through this adapter.
        capabilities: { versions: true, cursorSync: false, children: false, binaryFiles: false },
        getResource: Effect.fn("GitResourceAdapter.getResource")(function* (resourceId: string) {
            return yield* Effect.map(client.getRepository(resourceId), mapProviderRepositoryToResource);
        }),
        listResources: Effect.fn("GitResourceAdapter.listResources")(function* () {
            return yield* Effect.map(client.listRepositories(), (repositories) =>
                repositories.map(mapProviderRepositoryToResource)
            );
        }),
        listResourceVersions: Effect.fn("GitResourceAdapter.listResourceVersions")(function* (resourceId: string) {
            const repository = yield* client.getRepository(resourceId);
            const branches = yield* client.listBranches(repository);
            return branches.map((branch) => mapProviderBranchToResourceVersion(resourceId, branch));
        }),
        loadSnapshot: Effect.fn("GitResourceAdapter.loadSnapshot")(function* (
            resourceId: string,
            versionName: string,
            versionId?: string
        ) {
            const repository = yield* client.getRepository(resourceId);
            const snapshot = yield* client.loadRepositorySnapshot(repository, versionName, versionId);
            return mapProviderRepositorySnapshot(snapshot);
        }),
        compareVersions: Effect.fn("GitResourceAdapter.compareVersions")(function* (
            resourceId: string,
            fromVersionId: string,
            toVersionId: string
        ) {
            const repository = yield* client.getRepository(resourceId);
            const delta = yield* client.compareRepository(repository, fromVersionId, toVersionId);
            return mapProviderRepositoryDelta(delta);
        }),
        readFile: Effect.fn("GitResourceAdapter.readFile")(function* (
            resourceOrLocator: ConnectorFileLocator | ProviderRepository,
            path?: string,
            versionId?: string
        ) {
            if (isProviderRepository(resourceOrLocator)) {
                if (typeof path !== "string" || typeof versionId !== "string") {
                    return yield* Effect.fail(
                        new ConnectorProviderError("validation", "Repository file reads require a path and version ID")
                    );
                }
                return yield* client.readFile(resourceOrLocator, path, versionId);
            }

            if (typeof resourceOrLocator.versionId !== "string" || resourceOrLocator.versionId.length === 0) {
                return yield* Effect.fail(
                    new ConnectorProviderError("validation", "Connector file reads require a version ID")
                );
            }

            const repository = yield* client.getRepository(resourceOrLocator.resourceId);
            return yield* client.readFile(repository, resourceOrLocator.path, resourceOrLocator.versionId);
        }),
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

export function mapProviderBranchToResourceVersion(
    resourceId: string,
    branch: ProviderBranch
): ConnectorResourceVersion {
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
