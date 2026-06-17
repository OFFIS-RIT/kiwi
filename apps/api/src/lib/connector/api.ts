import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { connectorResourceBindingsTable } from "@kiwi/db/tables/connectors";
import { graphTable } from "@kiwi/db/tables/graph";
import type { ConnectorProvider, ConnectorRepositoryRecord } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import type { ProviderBranch, ProviderRepository } from "@kiwi/connectors";
import { syncConnectorResourceGraphSpec } from "@kiwi/worker/sync-connector-resource-graph-spec";
import { eq } from "drizzle-orm";
import { assertCanUseInstallation, requireActiveConnector, type ConnectorInstallationRow, type ConnectorRow } from "../connector-access";
import { listProviderBranches, listProviderRepositories } from "../connectors";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "../team/access";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";

export type ConnectorResourceKind = "git-repository";

export type ResolvedConnectorResource = {
    provider: ConnectorProvider;
    kind: ConnectorResourceKind;
    id: string;
    displayName: string;
    webUrl: string;
    private: boolean;
    defaultVersion: string | null;
    git: ConnectorRepositoryRecord;
};

export type ResolvedConnectorResourceVersion = {
    name: string;
    versionId: string;
    git: ProviderBranch;
};

export type ConnectorBindingCreateInput = {
    connectorInstallationId: string;
    resourceKind: ConnectorResourceKind;
    resourceId: string;
    resourceDisplayName?: string;
    resourceWebUrl?: string;
    versionName: string;
    versionId?: string;
    name: string;
    owner: { kind: "organization" } | { kind: "team"; teamId: string };
};

export function assertSystemAdmin(user: AuthUser) {
    if (!user.isSystemAdmin) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

export function resourceMatches(resource: Pick<ResolvedConnectorResource, "id" | "displayName">, requestedId: string) {
    return resource.id === requestedId || resource.displayName === requestedId;
}

export function assertInstallationBelongsToConnector(
    installation: Pick<ConnectorInstallationRow, "connectorId">,
    connectorId: string
) {
    if (installation.connectorId !== connectorId) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

type ConnectorResourceBinding = typeof connectorResourceBindingsTable.$inferSelect;

function tryUnknownPromise<T>(thunk: () => PromiseLike<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({ try: thunk, catch: (error) => error });
}

export function toBindingResponse(binding: ConnectorResourceBinding) {
    return {
        id: binding.id,
        graphId: binding.graphId,
        connectorInstallationId: binding.connectorInstallationId,
        provider: binding.provider as ConnectorProvider,
        providerRepositoryId: binding.providerResourceId,
        repositoryFullName: binding.resourceDisplayName,
        repositoryHtmlUrl: binding.resourceWebUrl,
        branch: binding.versionName,
        lastSeenCommitSha: binding.lastSeenVersionId,
        lastSyncedCommitSha: binding.lastSyncedVersionId,
        syncStatus: binding.syncStatus,
        syncErrorCode: binding.syncErrorCode,
        webhookEnabled: binding.webhookEnabled,
        createdAt: binding.createdAt?.toISOString() ?? null,
        updatedAt: binding.updatedAt?.toISOString() ?? null,
    };
}

export function requireConnectorInstallationContext(input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
}): Effect.Effect<{ connector: ConnectorRow; installation: ConnectorInstallationRow }, unknown> {
    return Effect.gen(function* () {
        const installation = yield* assertCanUseInstallation(input.user, input.installationId);
        if (installation.connectorId !== input.connectorId) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
        const connector = yield* requireActiveConnector(input.connectorId, installation.provider as ConnectorProvider);
        return { connector, installation };
    });
}

export function toConnectorResource(repository: ProviderRepository): ResolvedConnectorResource {
    return {
        provider: repository.provider,
        kind: "git-repository",
        id: repository.id,
        displayName: repository.fullName,
        webUrl: repository.htmlUrl,
        private: repository.private,
        defaultVersion: repository.defaultBranch,
        git: {
            id: repository.id,
            provider: repository.provider,
            fullName: repository.fullName,
            name: repository.name,
            htmlUrl: repository.htmlUrl,
            defaultBranch: repository.defaultBranch,
            private: repository.private,
            resourceKind: "git-repository",
            displayName: repository.fullName,
            webUrl: repository.htmlUrl,
            defaultVersionName: repository.defaultBranch ?? undefined,
        },
    };
}

export function toConnectorResourceVersion(branch: ProviderBranch): ResolvedConnectorResourceVersion {
    return { name: branch.name, versionId: branch.commitSha, git: branch };
}

export function listConnectorResourceRecords(
    connector: ConnectorRow,
    installation: ConnectorInstallationRow
): Effect.Effect<ResolvedConnectorResource[], unknown> {
    return Effect.map(listProviderRepositories(connector, installation), (repositories) =>
        repositories.map(toConnectorResource)
    );
}

export function listConnectorResourceVersionRecords(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
}): Effect.Effect<ResolvedConnectorResourceVersion[], unknown> {
    return Effect.map(listProviderBranches(input.connector, input.installation, input.resourceId), (branches) =>
        branches.map(toConnectorResourceVersion)
    );
}

export function assertCanBindResourceGraph(input: {
    user: AuthUser;
    installation: ConnectorInstallationRow;
    owner: ConnectorBindingCreateInput["owner"];
}): Effect.Effect<{ organizationId: string | null; teamId: string | null }, unknown> {
    return Effect.gen(function* () {
        if (input.owner.kind === "team") {
            if (input.installation.teamId !== input.owner.teamId) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }
            const access = yield* requireTeamGraphCreateAccess(input.user, input.owner.teamId);
            if (input.installation.organizationId !== access.team.organizationId) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }
            return { organizationId: input.installation.organizationId, teamId: input.owner.teamId };
        }

        if (input.installation.teamId !== null || !input.installation.organizationId) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
        yield* requireOrganizationAdmin(input.user, input.installation.organizationId);
        return { organizationId: input.installation.organizationId, teamId: null };
    });
}

export function createGraphBinding(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    body: ConnectorBindingCreateInput;
    resource: ResolvedConnectorResource;
    version: ResolvedConnectorResourceVersion;
}) {
    return tryUnknownPromise(() =>
        db.transaction(async (tx) => {
            const [graph] = await tx
                .insert(graphTable)
                .values({
                    organizationId: input.installation.organizationId,
                    teamId: input.body.owner.kind === "team" ? input.body.owner.teamId : null,
                    name: input.body.name,
                    description: null,
                    state: "updating",
                    type: "code",
                })
                .returning();

            const [binding] = await tx
                .insert(connectorResourceBindingsTable)
                .values({
                    graphId: graph.id,
                    connectorInstallationId: input.installation.id,
                    provider: input.connector.provider,
                    resourceKind: input.body.resourceKind,
                    providerResourceId: input.resource.id,
                    resourceDisplayName: input.resource.displayName,
                    resourceWebUrl: input.resource.webUrl,
                    versionName: input.version.name,
                    lastSeenVersionId: input.version.versionId,
                    syncStatus: "pending",
                })
                .returning();

            return { graph, binding };
        })
    );
}

export function enqueueInitialBindingSync(input: {
    graphId: string;
    bindingId: string;
    versionId: string;
}): Effect.Effect<string, unknown> {
    return tryUnknownPromise(async () => {
        try {
            const handle = await ow.runWorkflow(syncConnectorResourceGraphSpec, {
                bindingId: input.bindingId,
                reason: "initial",
                versionId: input.versionId,
            });
            return handle.workflowRun.id;
        } catch (error) {
            await Promise.all([
                db
                    .update(connectorResourceBindingsTable)
                    .set({ syncStatus: "failed", syncErrorCode: "enqueue_failed" })
                    .where(eq(connectorResourceBindingsTable.id, input.bindingId)),
                db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId)),
            ]);
            throw error;
        }
    });
}

export function enqueueManualBindingSync(binding: ConnectorResourceBinding): Effect.Effect<{
    binding: ConnectorResourceBinding;
    workflowRunId: string;
}, unknown> {
    return tryUnknownPromise(async () => {
        const [updatedBinding] = await db
            .update(connectorResourceBindingsTable)
            .set({ syncStatus: "pending", syncErrorCode: null })
            .where(eq(connectorResourceBindingsTable.id, binding.id))
            .returning();
        try {
            const handle = await ow.runWorkflow(syncConnectorResourceGraphSpec, {
                bindingId: binding.id,
                reason: "manual",
            });
            return { binding: updatedBinding ?? binding, workflowRunId: handle.workflowRun.id };
        } catch (error) {
            await db
                .update(connectorResourceBindingsTable)
                .set({ syncStatus: "failed", syncErrorCode: "enqueue_failed" })
                .where(eq(connectorResourceBindingsTable.id, binding.id));
            throw error;
        }
    });
}

export function requireGitRepositoryResource(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
}): Effect.Effect<ResolvedConnectorResource, unknown> {
    return Effect.gen(function* () {
        const resources = yield* listConnectorResourceRecords(input.connector, input.installation);
        const resource = resources.find((candidate) => resourceMatches(candidate, input.resourceId));
        if (!resource) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
        }
        return resource;
    });
}

export function requireGitResourceVersion(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
    versionName: string;
}): Effect.Effect<ResolvedConnectorResourceVersion, unknown> {
    return Effect.gen(function* () {
        const versions = yield* listConnectorResourceVersionRecords(input);
        const version = versions.find((candidate) => candidate.name === input.versionName);
        if (!version) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
        }
        return version;
    });
}
