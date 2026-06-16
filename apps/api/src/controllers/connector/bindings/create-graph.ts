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
import { tryApiPromise } from "../../_shared/api-effect";

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
}) {
    return tryApiPromise(async () => {
        const body = toConnectorBindingCreateInput(input.body);
        const { connector, installation } = await requireConnectorInstallationContext({
            user: input.user,
            connectorId: input.connectorId,
            installationId: body.connectorInstallationId,
        });
    
        await assertCanBindResourceGraph({ user: input.user, installation, owner: body.owner });
        const resource = await requireGitRepositoryResource({ connector, installation, resourceId: body.resourceId });
        const version = await requireGitResourceVersion({
            connector,
            installation,
            resourceId: resource.id,
            versionName: body.versionName,
        });
        const created = await createGraphBinding({ connector, installation, body, resource, version });
        const workflowRunId = await enqueueInitialBindingSync({
            graphId: created.graph.id,
            bindingId: created.binding.id,
            versionId: version.versionId,
        });
    
        return {
            graph: created.graph,
            binding: toBindingResponse(created.binding),
            workflowRunId,
        };
    });
}
