import * as Effect from "effect/Effect";
import { DatabaseError, tryDb, tryDbVoid, type Database } from "@kiwi/db/effect";
import { connectorResourceBindingsTable } from "@kiwi/db/tables/connectors";
import { graphTable } from "@kiwi/db/tables/graph";
import type {
    ConnectorBindingCreateInput as ContractConnectorBindingCreateInput,
    ConnectorProvider,
    ConnectorRepositoryRecord,
    ConnectorResourceKind as ContractConnectorResourceKind,
} from "@kiwi/contracts/connectors";
import {
    API_ERROR_CODES,
    forbiddenError,
    graphNotFoundError,
    isApiError,
    makeApiError,
    type ApiError,
} from "@kiwi/contracts/errors";
import type { ProviderBranch, ProviderRepository } from "@kiwi/connectors";
import { syncConnectorResourceGraphSpec } from "@kiwi/worker/sync-connector-resource-graph-spec";
import { eq } from "@kiwi/db/drizzle";
import {
    assertCanUseInstallation,
    requireActiveConnector,
    type ConnectorInstallationRow,
    type ConnectorRow,
} from "../connector-access";
import { listProviderBranches, listProviderRepositories } from "../connectors";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "../team/access";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";

function connectorEffectError(error: unknown): ApiError | DatabaseError {
    if (error instanceof DatabaseError) {
        return error;
    }
    if (isApiError(error)) {
        return error;
    }
    return makeApiError(
        400,
        API_ERROR_CODES.INVALID_CHAT_REQUEST,
        error instanceof Error
            ? error.message.replace(/^Unhandled exception:\s*/u, "") || "Invalid connector request"
            : "Invalid connector request"
    );
}

export type ConnectorResourceKind = ContractConnectorResourceKind;

export type ResolvedConnectorResource = {
    provider: ConnectorProvider;
    kind: ConnectorResourceKind;
    id: string;
    displayName: string;
    webUrl: string;
    private: boolean;
    defaultVersionName: string | null;
    defaultVersionId?: string;
    git?: ConnectorRepositoryRecord;
};

export type ResolvedConnectorResourceVersion = {
    name: string;
    versionId: string;
    resourceId?: string;
    git?: ProviderBranch;
};

export type ConnectorBindingCreateInput = ContractConnectorBindingCreateInput & {
    syncEnabled?: boolean;
    webhookEnabled?: boolean;
};

export function assertSystemAdmin(user: AuthUser) {
    if (!user.isSystemAdmin) {
        throw forbiddenError();
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
        throw forbiddenError();
    }
}

type ConnectorResourceBinding = typeof connectorResourceBindingsTable.$inferSelect;

export type ConnectorBindingResponse = {
    id: string;
    graphId: string;
    connectorInstallationId: string;
    provider: ConnectorProvider;
    resourceKind: ConnectorResourceKind;
    resourceId: string;
    providerResourceId: string;
    resourceDisplayName: string;
    resourceWebUrl: string;
    versionName: string | null;
    versionId: string | null;
    lastSeenVersionId: string | null;
    lastSyncedVersionId: string | null;
    syncCursor: string | null;
    metadata: unknown | null;
    syncStatus: ConnectorResourceBinding["syncStatus"];
    syncErrorCode: string | null;
    syncEnabled: boolean;
    webhookEnabled: boolean;
    providerRepositoryId: string;
    repositoryFullName: string;
    repositoryHtmlUrl: string;
    branch: string | null;
    lastSeenCommitSha: string | null;
    lastSyncedCommitSha: string | null;
    createdAt: string | null;
    updatedAt: string | null;
};

function parseBindingMetadata(value: string | null): unknown | null {
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}

export function toBindingResponse(binding: ConnectorResourceBinding): ConnectorBindingResponse {
    const metadata = parseBindingMetadata(binding.resourceMetadata);
    return {
        id: binding.id,
        graphId: binding.graphId,
        connectorInstallationId: binding.connectorInstallationId,
        provider: binding.provider as ConnectorProvider,
        resourceKind: binding.resourceKind as ConnectorResourceKind,
        resourceId: binding.providerResourceId,
        providerResourceId: binding.providerResourceId,
        resourceDisplayName: binding.resourceDisplayName,
        resourceWebUrl: binding.resourceWebUrl,
        versionName: binding.versionName,
        versionId: binding.lastSeenVersionId,
        lastSeenVersionId: binding.lastSeenVersionId,
        lastSyncedVersionId: binding.lastSyncedVersionId,
        syncCursor: binding.syncCursor,
        metadata,
        syncStatus: binding.syncStatus,
        syncErrorCode: binding.syncErrorCode,
        syncEnabled: binding.syncEnabled,
        webhookEnabled: binding.webhookEnabled,
        providerRepositoryId: binding.providerResourceId,
        repositoryFullName: binding.resourceDisplayName,
        repositoryHtmlUrl: binding.resourceWebUrl,
        branch: binding.versionName,
        lastSeenCommitSha: binding.lastSeenVersionId,
        lastSyncedCommitSha: binding.lastSyncedVersionId,
        createdAt: binding.createdAt?.toISOString() ?? null,
        updatedAt: binding.updatedAt?.toISOString() ?? null,
    };
}

export function requireConnectorInstallationContext(input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
}): Effect.Effect<
    { connector: ConnectorRow; installation: ConnectorInstallationRow },
    ApiError | DatabaseError,
    Database
> {
    return Effect.gen(function* () {
        const installation = yield* assertCanUseInstallation(input.user, input.installationId);
        if (installation.connectorId !== input.connectorId) {
            return yield* Effect.fail(forbiddenError());
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
        defaultVersionName: repository.defaultBranch,
        git: {
            id: repository.id,
            provider: repository.provider,
            fullName: repository.fullName,
            name: repository.name,
            htmlUrl: repository.htmlUrl,
            defaultBranch: repository.defaultBranch,
            private: repository.private,
            resourceKind: "git-repository",
            resourceId: repository.id,
            providerResourceId: repository.id,
            resourceDisplayName: repository.fullName,
            resourceWebUrl: repository.htmlUrl,
            displayName: repository.fullName,
            webUrl: repository.htmlUrl,
            defaultVersionName: repository.defaultBranch ?? undefined,
        },
    };
}

export function toConnectorResourceVersion(
    resourceId: string,
    branch: ProviderBranch
): ResolvedConnectorResourceVersion {
    return { name: branch.name, versionId: branch.commitSha, resourceId, git: branch };
}

export function listConnectorResourceRecords(
    connector: ConnectorRow,
    installation: ConnectorInstallationRow
): Effect.Effect<ResolvedConnectorResource[], ApiError> {
    return Effect.map(listProviderRepositories(connector, installation), (repositories) =>
        repositories.map(toConnectorResource)
    );
}

export function listConnectorResourceVersionRecords(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
}): Effect.Effect<ResolvedConnectorResourceVersion[], ApiError> {
    return Effect.map(listProviderBranches(input.connector, input.installation, input.resourceId), (branches) =>
        branches.map((branch) => toConnectorResourceVersion(input.resourceId, branch))
    );
}

export type ConnectorGraphOwnerScope = {
    organizationId: string | null;
    teamId: string | null;
    userId: string | null;
};

export function assertCanBindResourceGraph(input: {
    user: AuthUser;
    installation: ConnectorInstallationRow;
    owner: ConnectorBindingCreateInput["owner"];
}): Effect.Effect<ConnectorGraphOwnerScope, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        if (input.owner.kind === "user") {
            if (
                input.owner.userId !== input.user.id ||
                input.installation.subjectKind !== "user" ||
                input.installation.subjectUserId !== input.owner.userId
            ) {
                return yield* Effect.fail(forbiddenError());
            }
            return { organizationId: null, teamId: null, userId: input.owner.userId };
        }

        if (input.owner.kind === "team") {
            const installationTeamId = input.installation.subjectTeamId ?? input.installation.teamId;
            if (installationTeamId !== input.owner.teamId) {
                return yield* Effect.fail(forbiddenError());
            }
            const access = yield* Effect.mapError(
                requireTeamGraphCreateAccess(input.user, input.owner.teamId),
                connectorEffectError
            );
            if (input.installation.organizationId && input.installation.organizationId !== access.team.organizationId) {
                return yield* Effect.fail(forbiddenError());
            }
            return { organizationId: access.team.organizationId, teamId: input.owner.teamId, userId: null };
        }

        const organizationId =
            input.owner.organizationId ?? input.installation.subjectOrganizationId ?? input.installation.organizationId;
        if (input.installation.subjectKind === "team" || input.installation.teamId !== null || !organizationId) {
            return yield* Effect.fail(forbiddenError());
        }
        const membership = yield* Effect.mapError(
            requireOrganizationAdmin(input.user, organizationId),
            connectorEffectError
        );
        return { organizationId: membership.organizationId, teamId: null, userId: null };
    });
}

export function createGraphBinding(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    ownerScope: ConnectorGraphOwnerScope;
    body: ConnectorBindingCreateInput;
    resource: ResolvedConnectorResource;
    version?: ResolvedConnectorResourceVersion;
}): Effect.Effect<
    { graph: typeof graphTable.$inferSelect; binding: ConnectorResourceBinding },
    DatabaseError,
    Database
> {
    return tryDb((db) =>
        db.transaction((tx) =>
            Effect.gen(function* (): Generator<
                Effect.Effect<unknown, unknown>,
                { graph: typeof graphTable.$inferSelect; binding: ConnectorResourceBinding }
            > {
                const [graph] = yield* tx
                    .insert(graphTable)
                    .values({
                        organizationId: input.ownerScope.organizationId,
                        teamId: input.ownerScope.teamId,
                        userId: input.ownerScope.userId,
                        name: input.body.name,
                        description: null,
                        state: "updating",
                        type: "code",
                    })
                    .returning();

                const [binding] = yield* tx
                    .insert(connectorResourceBindingsTable)
                    .values({
                        graphId: graph.id,
                        connectorInstallationId: input.installation.id,
                        provider: input.connector.provider,
                        resourceKind: input.body.resourceKind,
                        providerResourceId: input.resource.id,
                        resourceDisplayName: input.resource.displayName,
                        resourceWebUrl: input.resource.webUrl,
                        versionName: input.version?.name ?? input.body.versionName ?? null,
                        lastSeenVersionId: input.version?.versionId ?? input.body.versionId ?? null,
                        syncCursor: input.body.syncCursor,
                        resourceMetadata:
                            input.body.metadata === undefined ? null : JSON.stringify(input.body.metadata),
                        syncEnabled: input.body.syncEnabled ?? true,
                        webhookEnabled: input.body.webhookEnabled ?? input.body.resourceKind === "git-repository",
                        syncStatus: "pending",
                    })
                    .returning();

                return { graph, binding };
            })
        )
    );
}

export function enqueueInitialBindingSync(input: {
    graphId: string;
    bindingId: string;
    versionId?: string;
}): Effect.Effect<string, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        return yield* Effect.matchEffect(
            Effect.tryPromise({
                try: async () => {
                    const handle = await ow.runWorkflow(syncConnectorResourceGraphSpec, {
                        bindingId: input.bindingId,
                        reason: "initial",
                        ...(input.versionId ? { versionId: input.versionId } : {}),
                    });
                    return handle.workflowRun.id;
                },
                catch: connectorEffectError,
            }),
            {
                onFailure: (error) =>
                    Effect.gen(function* () {
                        yield* tryDbVoid((db) =>
                            Promise.all([
                                db
                                    .update(connectorResourceBindingsTable)
                                    .set({ syncStatus: "failed", syncErrorCode: "enqueue_failed" })
                                    .where(eq(connectorResourceBindingsTable.id, input.bindingId)),
                                db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId)),
                            ])
                        );
                        return yield* Effect.fail(error);
                    }),
                onSuccess: (workflowRunId) => Effect.succeed(workflowRunId),
            }
        );
    });
}

export function enqueueManualBindingSync(binding: ConnectorResourceBinding): Effect.Effect<
    {
        binding: ConnectorResourceBinding;
        workflowRunId: string;
    },
    ApiError | DatabaseError,
    Database
> {
    return Effect.gen(function* () {
        const [updatedBinding] = yield* tryDb((db) =>
            db
                .update(connectorResourceBindingsTable)
                .set({ syncStatus: "pending", syncErrorCode: null })
                .where(eq(connectorResourceBindingsTable.id, binding.id))
                .returning()
        );
        const workflowRunId = yield* Effect.matchEffect(
            Effect.tryPromise({
                try: async () => {
                    const handle = await ow.runWorkflow(syncConnectorResourceGraphSpec, {
                        bindingId: binding.id,
                        reason: "manual",
                    });
                    return handle.workflowRun.id;
                },
                catch: connectorEffectError,
            }),
            {
                onFailure: (error) =>
                    Effect.gen(function* () {
                        yield* tryDbVoid((db) =>
                            db
                                .update(connectorResourceBindingsTable)
                                .set({ syncStatus: "failed", syncErrorCode: "enqueue_failed" })
                                .where(eq(connectorResourceBindingsTable.id, binding.id))
                        );
                        return yield* Effect.fail(error);
                    }),
                onSuccess: (id) => Effect.succeed(id),
            }
        );
        return { binding: updatedBinding ?? binding, workflowRunId };
    });
}

export function requireConnectorResource(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceKind: ConnectorResourceKind;
    resourceId: string;
}): Effect.Effect<ResolvedConnectorResource, ApiError> {
    return Effect.gen(function* () {
        const resources = yield* listConnectorResourceRecords(input.connector, input.installation);
        const resource = resources.find(
            (candidate) => candidate.kind === input.resourceKind && resourceMatches(candidate, input.resourceId)
        );
        if (!resource) {
            return yield* Effect.fail(graphNotFoundError());
        }
        return resource;
    });
}

export function requireConnectorResourceVersion(input: {
    connector: ConnectorRow;
    installation: ConnectorInstallationRow;
    resourceId: string;
    versionName: string;
}): Effect.Effect<ResolvedConnectorResourceVersion, ApiError> {
    return Effect.gen(function* () {
        const versions = yield* listConnectorResourceVersionRecords(input);
        const version = versions.find((candidate) => candidate.name === input.versionName);
        if (!version) {
            return yield* Effect.fail(graphNotFoundError());
        }
        return version;
    });
}
