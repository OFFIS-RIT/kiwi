import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { graphTable } from "@kiwi/db/tables/graph";
import type { RepositoryGraphCreateInput } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../../middleware/auth";
import {
    assertCanBindResourceGraph,
    createGraphBinding,
    enqueueInitialBindingSync,
    requireConnectorInstallationContext,
    requireGitRepositoryResource,
    requireGitResourceVersion,
    toBindingResponse,
    type ConnectorBindingCreateInput,
} from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError, tryApiSync } from "../../_shared/api-effect"

function toConnectorBindingCreateInput(body: RepositoryGraphCreateInput): ConnectorBindingCreateInput {
    const resourceKind = body.resourceKind ?? "git-repository";
    if (resourceKind !== "git-repository") {
        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
    }
    return {
        connectorInstallationId: body.connectorInstallationId,
        resourceKind,
        resourceId: body.resourceId ?? body.repositoryId,
        resourceDisplayName: body.resourceDisplayName ?? body.repositoryFullName,
        resourceWebUrl: body.resourceWebUrl ?? body.repositoryHtmlUrl,
        versionName: body.versionName ?? body.branch,
        versionId: body.versionId,
        name: body.name,
        owner: body.owner,
    };
}

export function createConnectorGraphBinding(input: {
    user: AuthUser;
    connectorId: string;
    body: RepositoryGraphCreateInput;
}): Effect.Effect<{ graph: typeof graphTable.$inferSelect; binding: ReturnType<typeof toBindingResponse>; workflowRunId: string }, ReturnType<typeof toApiError>, Database> {
    return Effect.mapError(Effect.gen(function* () {
        const body = yield* tryApiSync(() => toConnectorBindingCreateInput(input.body));
        const { connector, installation } = yield* requireConnectorInstallationContext({
            user: input.user,
            connectorId: input.connectorId,
            installationId: body.connectorInstallationId,
        });
    
        yield* assertCanBindResourceGraph({ user: input.user, installation, owner: body.owner });
        const resource = yield* requireGitRepositoryResource({ connector, installation, resourceId: body.resourceId });
        const version = yield* requireGitResourceVersion({
            connector,
            installation,
            resourceId: resource.id,
            versionName: body.versionName,
        });
        const created = yield* createGraphBinding({ connector, installation, body, resource, version });
        const workflowRunId = yield* enqueueInitialBindingSync({
            graphId: created.graph.id,
            bindingId: created.binding.id,
            versionId: version.versionId,
        });
    
        return {
            graph: created.graph,
            binding: toBindingResponse(created.binding),
            workflowRunId,
        };
    }), (error) => toApiError(error, connectorApiErrorOptions));
}
