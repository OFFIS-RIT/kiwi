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
import { assertCanCreateTeamGraph } from "../graph/access";
import { requireOrganizationAdmin } from "../team/access";
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

export async function requireConnectorInstallationContext(input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
}) {
    const installation = await assertCanUseInstallation(input.user, input.installationId);
    assertInstallationBelongsToConnector(installation, input.connectorId);
    const connector = await requireActiveConnector(input.connectorId, installation.provider as ConnectorProvider);
    return { connector, installation };
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

export async function listConnectorResourceRecords(
    connector: ConnectorRow,
    installation: ConnectorInstallationRow
): Promise<ResolvedConnectorResource[]> {
    return (await listProviderRepositories(connector, installation)).map(toConnectorResource);
}

export async function listConnectorResourceVersionRecords(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
}): Promise<ResolvedConnectorResourceVersion[]> {
    const branches = await listProviderBranches(input.connector, input.installation, input.resourceId);
    return branches.map(toConnectorResourceVersion);
}

export async function assertCanBindResourceGraph(input: {
    user: AuthUser;
    installation: ConnectorInstallationRow;
    owner: ConnectorBindingCreateInput["owner"];
}) {
    if (input.owner.kind === "team") {
        if (input.installation.teamId !== input.owner.teamId) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }
        const access = await assertCanCreateTeamGraph(input.user, input.owner.teamId);
        if (input.installation.organizationId !== access.team.organizationId) {
            throw new Error(API_ERROR_CODES.FORBIDDEN);
        }
        return { organizationId: input.installation.organizationId, teamId: input.owner.teamId };
    }

    if (input.installation.teamId !== null || !input.installation.organizationId) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
    await requireOrganizationAdmin(input.user, input.installation.organizationId);
    return { organizationId: input.installation.organizationId, teamId: null };
}

export async function createGraphBinding(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    body: ConnectorBindingCreateInput;
    resource: ResolvedConnectorResource;
    version: ResolvedConnectorResourceVersion;
}) {
    return db.transaction(async (tx) => {
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
    });
}

export async function enqueueInitialBindingSync(input: {
    graphId: string;
    bindingId: string;
    versionId: string;
}): Promise<string> {
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
}

export async function enqueueManualBindingSync(binding: ConnectorResourceBinding): Promise<{
    binding: ConnectorResourceBinding;
    workflowRunId: string;
}> {
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
}

export async function requireGitRepositoryResource(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
}) {
    const resources = await listConnectorResourceRecords(input.connector, input.installation);
    const resource = resources.find((candidate) => resourceMatches(candidate, input.resourceId));
    if (!resource) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }
    return resource;
}

export async function requireGitResourceVersion(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
    versionName: string;
}) {
    const versions = await listConnectorResourceVersionRecords(input);
    const version = versions.find((candidate) => candidate.name === input.versionName);
    if (!version) {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }
    return version;
}
