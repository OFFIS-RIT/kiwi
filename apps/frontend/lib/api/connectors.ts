import type {
    ApiResponse,
    ConnectorBranchListResponse,
    ConnectorBranchRecord,
    ConnectorConnectStartResponse,
    ConnectorInstallationListResponse,
    ConnectorInstallationRecord,
    ConnectorListResponse,
    ConnectorRecord,
    ConnectorRepositoryListResponse,
    ConnectorRepositoryRecord,
    GitHubConnectorManifestStartInput,
    GitHubConnectorManifestStartResponse,
    GitHubConnectorManifestStartSuccessData,
    GitLabConnectorCreateInput,
    GitLabConnectorCreateResponse,
    RepositoryGraphBindingResponse,
    RepositoryGraphBindingRecord,
    RepositoryGraphBindingSyncResponse,
    RepositoryGraphBindingSyncSuccessData,
    RepositoryGraphCreateInput,
    RepositoryGraphCreateResponse,
    RepositoryGraphCreateSuccessData,
} from "@kiwi/contracts";

import { unwrapApiResponse, type KiwiApiClient } from "./client";

export async function fetchConnectors(client: KiwiApiClient): Promise<ConnectorRecord[]> {
    const response = await client.get<ConnectorListResponse>("/connectors");
    return unwrapApiResponse(response);
}

export async function startGitHubConnectorManifest(
    client: KiwiApiClient,
    input: GitHubConnectorManifestStartInput
): Promise<GitHubConnectorManifestStartSuccessData> {
    const response = await client.post<GitHubConnectorManifestStartResponse>(
        "/connectors/github/manifest/start",
        input
    );
    return unwrapApiResponse(response);
}

export async function completeGitHubConnectorManifest(
    client: KiwiApiClient,
    input: { code: string; state: string }
): Promise<ConnectorRecord> {
    const params = new URLSearchParams(input);
    const response = await client.get<
        ApiResponse<
            ConnectorRecord,
            "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
        >
    >(`/connectors/github/manifest/callback?${params.toString()}`);
    return unwrapApiResponse(response);
}

export async function completeGitHubConnectorInstallation(
    client: KiwiApiClient,
    input: { state: string; installation_id: string; setup_action?: string }
): Promise<ConnectorInstallationRecord> {
    const params = new URLSearchParams();
    params.set("state", input.state);
    params.set("installation_id", input.installation_id);
    if (input.setup_action) {
        params.set("setup_action", input.setup_action);
    }
    const response = await client.get<
        ApiResponse<
            ConnectorInstallationRecord,
            "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
        >
    >(`/connectors/github/install/callback?${params.toString()}`);
    return unwrapApiResponse(response);
}

export async function createGitLabConnector(
    client: KiwiApiClient,
    input: GitLabConnectorCreateInput
): Promise<ConnectorRecord> {
    const response = await client.post<GitLabConnectorCreateResponse>("/connectors/gitlab", input);
    return unwrapApiResponse(response);
}
export async function startConnectorConnect(
    client: KiwiApiClient,
    connectorId: string,
    input: { organizationId?: string; teamId?: string }
): Promise<{ redirectUrl: string }> {
    const params = new URLSearchParams();
    if (input.organizationId) {
        params.set("organizationId", input.organizationId);
    }
    if (input.teamId) {
        params.set("teamId", input.teamId);
    }
    const response = await client.get<ConnectorConnectStartResponse>(
        `/connectors/${encodeURIComponent(connectorId)}/connect?${params.toString()}`
    );
    return unwrapApiResponse(response);
}

export async function fetchConnectorInstallations(
    client: KiwiApiClient,
    connectorId: string
): Promise<ConnectorInstallationRecord[]> {
    const response = await client.get<ConnectorInstallationListResponse>(
        `/connectors/${encodeURIComponent(connectorId)}/installations`
    );
    return unwrapApiResponse(response);
}

export async function fetchConnectorRepositories(
    client: KiwiApiClient,
    connectorId: string,
    installationId: string
): Promise<ConnectorRepositoryRecord[]> {
    const params = new URLSearchParams({ installationId });
    const response = await client.get<ConnectorRepositoryListResponse>(
        `/connectors/${encodeURIComponent(connectorId)}/repositories?${params.toString()}`
    );
    return unwrapApiResponse(response);
}

export async function fetchConnectorBranches(
    client: KiwiApiClient,
    connectorId: string,
    installationId: string,
    repositoryId: string
): Promise<ConnectorBranchRecord[]> {
    const params = new URLSearchParams({ installationId });
    const response = await client.get<ConnectorBranchListResponse>(
        `/connectors/${encodeURIComponent(connectorId)}/repositories/${encodeURIComponent(repositoryId)}/branches?${params.toString()}`
    );
    return unwrapApiResponse(response);
}

export async function createRepositoryGraph(
    client: KiwiApiClient,
    connectorId: string,
    input: RepositoryGraphCreateInput
): Promise<RepositoryGraphCreateSuccessData> {
    const response = await client.post<RepositoryGraphCreateResponse>(
        `/connectors/${encodeURIComponent(connectorId)}/repository-graphs`,
        input
    );
    return unwrapApiResponse(response);
}

export async function fetchRepositoryGraphBinding(
    client: KiwiApiClient,
    bindingId: string
): Promise<RepositoryGraphBindingRecord> {
    const response = await client.get<RepositoryGraphBindingResponse>(
        `/repository-graph-bindings/${encodeURIComponent(bindingId)}`
    );
    return unwrapApiResponse(response);
}

export async function syncRepositoryGraphBinding(
    client: KiwiApiClient,
    bindingId: string
): Promise<RepositoryGraphBindingSyncSuccessData> {
    const response = await client.post<RepositoryGraphBindingSyncResponse>(
        `/repository-graph-bindings/${encodeURIComponent(bindingId)}/sync`
    );
    return unwrapApiResponse(response);
}

export type {
    ConnectorBranchRecord,
    ConnectorInstallationRecord,
    ConnectorRecord,
    ConnectorRepositoryRecord,
    GitHubConnectorManifestStartInput,
    GitLabConnectorCreateInput,
    RepositoryGraphBindingRecord,
    RepositoryGraphCreateInput,
};
