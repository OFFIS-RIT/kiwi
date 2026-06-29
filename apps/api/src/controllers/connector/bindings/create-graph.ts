import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { graphTable } from "@kiwi/db/tables/graph";
import type { ConnectorResourceKind } from "@kiwi/contracts/connectors";
import type { ApiError } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../../middleware/auth";
import {
    assertCanBindResourceGraph,
    createGraphBinding,
    disableFileBindingsCoveredByFolder,
    enqueueInitialBindingSync,
    requireConnectorInstallationContext,
    requireConnectorResource,
    requireConnectorResourceVersion,
    toBindingResponse,
    type ConnectorBindingCreateInput,
    type ConnectorBindingResponse,
    type ResolvedConnectorResource,
    type ResolvedConnectorResourceVersion,
} from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError, tryApiSync } from "../../_shared/api-effect";

export type ConnectorGraphCreateRequest = {
    connectorInstallationId: string;
    resourceKind?: ConnectorResourceKind;
    resourceId?: string;
    resourceDisplayName?: string;
    resourceWebUrl?: string;
    versionName?: string;
    versionId?: string;
    syncCursor?: string;
    resourcePath?: string;
    providerItemId?: string;
    metadata?: unknown;
    resourceMetadata?: unknown;
    syncEnabled?: boolean;
    webhookEnabled?: boolean;
    repositoryId?: string;
    repositoryFullName?: string;
    repositoryHtmlUrl?: string;
    branch?: string;
    name: string;
    owner: ConnectorBindingCreateInput["owner"];
};

function toConnectorBindingCreateInput(body: ConnectorGraphCreateRequest): ConnectorBindingCreateInput {
    const resourceId = body.resourceId ?? body.repositoryId;
    const resourceDisplayName = body.resourceDisplayName ?? body.repositoryFullName;
    const resourceWebUrl = body.resourceWebUrl ?? body.repositoryHtmlUrl;
    if (!resourceId || !resourceDisplayName || !resourceWebUrl) {
        throw new Error("Connector resource fields are required");
    }
    return {
        connectorInstallationId: body.connectorInstallationId,
        resourceKind: body.resourceKind ?? "git-repository",
        resourceId,
        resourceDisplayName,
        resourceWebUrl,
        versionName: body.versionName ?? body.branch,
        versionId: body.versionId,
        syncCursor: body.syncCursor,
        resourcePath: body.resourcePath,
        providerItemId: body.providerItemId,
        metadata: body.metadata ?? body.resourceMetadata,
        syncEnabled: body.syncEnabled,
        webhookEnabled: body.webhookEnabled,
        name: body.name,
        owner: body.owner,
    };
}

function toRequestedConnectorResource(provider: string, body: ConnectorBindingCreateInput): ResolvedConnectorResource {
    return {
        provider,
        kind: body.resourceKind,
        id: body.resourceId,
        displayName: body.resourceDisplayName,
        webUrl: body.resourceWebUrl,
        private: false,
        defaultVersionName: body.versionName ?? null,
        defaultVersionId: body.versionId,
    };
}

function toRequestedConnectorResourceVersion(
    body: ConnectorBindingCreateInput
): ResolvedConnectorResourceVersion | undefined {
    if (!body.versionName) {
        return undefined;
    }
    return {
        name: body.versionName,
        versionId: body.versionId ?? body.versionName,
        resourceId: body.resourceId,
    };
}

function assertConnectorResourceKindSupported(provider: string, resourceKind: ConnectorResourceKind) {
    if ((provider === "github" || provider === "gitlab") && resourceKind !== "git-repository") {
        throw new Error("Git connectors only support repository resources");
    }
}

export type ConnectorGraphBindingCreateResult = {
    graph: typeof graphTable.$inferSelect;
    binding: ConnectorBindingResponse;
    workflowRunId: string | null;
};

export const createConnectorGraphBinding: (input: {
    user: AuthUser;
    connectorId: string;
    body: ConnectorGraphCreateRequest;
}) => Effect.Effect<ConnectorGraphBindingCreateResult, ApiError, Database> = Effect.fn("createConnectorGraphBinding")(
    (input: { user: AuthUser; connectorId: string; body: ConnectorGraphCreateRequest }) =>
        Effect.mapError(
            Effect.gen(function* () {
                const body = yield* tryApiSync(() => toConnectorBindingCreateInput(input.body));
                const { connector, installation } = yield* requireConnectorInstallationContext({
                    user: input.user,
                    connectorId: input.connectorId,
                    installationId: body.connectorInstallationId,
                });
                yield* tryApiSync(
                    () => assertConnectorResourceKindSupported(connector.provider, body.resourceKind),
                    connectorApiErrorOptions
                );

                const ownerScope = yield* assertCanBindResourceGraph({
                    user: input.user,
                    installation,
                    owner: body.owner,
                });
                const resource =
                    body.resourceKind === "git-repository"
                        ? yield* requireConnectorResource({
                              connector,
                              installation,
                              resourceKind: body.resourceKind,
                              resourceId: body.resourceId,
                          })
                        : toRequestedConnectorResource(connector.provider, body);
                const version =
                    body.resourceKind === "git-repository" && body.versionName
                        ? yield* requireConnectorResourceVersion({
                              connector,
                              installation,
                              resourceId: resource.id,
                              versionName: body.versionName,
                          })
                        : toRequestedConnectorResourceVersion(body);
                const created = yield* createGraphBinding({
                    connector,
                    installation,
                    ownerScope,
                    body,
                    resource,
                    version,
                });
                if (body.resourceKind === "folder") {
                    yield* disableFileBindingsCoveredByFolder({
                        installation,
                        folderResourceId: resource.id,
                        folderResourcePath: body.resourcePath,
                    });
                }
                const workflowRunId = yield* enqueueInitialBindingSync({
                    graphId: created.graph.id,
                    bindingId: created.binding.id,
                    versionId: version?.versionId,
                });

                return {
                    graph: created.graph,
                    binding: toBindingResponse(created.binding),
                    workflowRunId,
                };
            }),
            (error) => toApiError(error, connectorApiErrorOptions)
        )
);
