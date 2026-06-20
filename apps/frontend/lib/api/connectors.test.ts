import { describe, expect, test, vi } from "vitest";
import type { KiwiApiClient } from "./client";
import {
    completeGitHubConnectorInstallation,
    completeGitHubConnectorManifest,
    createGitLabConnector,
    createRepositoryGraph,
    fetchConnectorBranches,
    fetchConnectorInstallations,
    fetchConnectorRepositories,
    fetchConnectors,
    startConnectorConnect,
    startGitHubConnectorManifest,
    syncRepositoryGraphBinding,
} from "./connectors";

const connector = {
    id: "connector-1",
    provider: "github" as const,
    name: "GitHub",
    slug: "github",
    status: "active" as const,
    appId: "123",
    clientId: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
};

const installation = {
    id: "installation-1",
    connectorId: connector.id,
    provider: "github" as const,
    providerInstallationId: "987",
    providerAccountLogin: "kiwi-org",
    providerAccountType: "organization" as const,
    organizationId: "org-1",
    teamId: null,
    repositorySelection: "selected" as const,
    status: "active" as const,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
};

const repository = {
    provider: "github" as const,
    id: "repo/1",
    fullName: "kiwi/app",
    name: "app",
    htmlUrl: "https://github.com/kiwi/app",
    defaultBranch: "main",
    private: true,
};

const branch = { name: "main", commitSha: "abc123" };

const binding = {
    id: "binding-1",
    graphId: "graph-1",
    connectorInstallationId: installation.id,
    provider: "github" as const,
    providerRepositoryId: repository.id,
    repositoryFullName: repository.fullName,
    repositoryHtmlUrl: repository.htmlUrl,
    branch: branch.name,
    lastSeenCommitSha: branch.commitSha,
    lastSyncedCommitSha: null,
    syncStatus: "pending" as const,
    syncErrorCode: null,
    webhookEnabled: true,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
};

describe("connector API helpers", () => {
    test("fetches connectors", async () => {
        const get = vi.fn(async () => ({ status: "success" as const, data: [connector] }));
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(fetchConnectors(client)).resolves.toEqual([connector]);
        expect(get).toHaveBeenCalledWith("/connectors");
    });

    test("starts the GitHub manifest flow", async () => {
        const input = { name: "GitHub" };
        const data = { manifestUrl: "https://github.com/settings/apps/new", state: "state-1" };
        const post = vi.fn(async () => ({ status: "success" as const, data }));
        const client = { baseURL: "/api", post } as unknown as KiwiApiClient;

        await expect(startGitHubConnectorManifest(client, input)).resolves.toEqual(data);
        expect(post).toHaveBeenCalledWith("/connectors/github/manifest/start", input);
    });

    test("creates a GitLab connector without rendering returned secrets", async () => {
        const input = {
            name: "GitLab",
            baseUrl: "https://gitlab.com",
            clientId: "client-id",
            clientSecret: "client-secret",
            webhookSecret: "webhook-secret",
        };
        const post = vi.fn(async () => ({
            status: "success" as const,
            data: { ...connector, provider: "gitlab" as const },
        }));
        const client = { baseURL: "/api", post } as unknown as KiwiApiClient;

        await expect(createGitLabConnector(client, input)).resolves.toMatchObject({ provider: "gitlab" });
        expect(post).toHaveBeenCalledWith("/connectors/gitlab", input);
    });

    test("completes GitHub connector callbacks through API routes", async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({ status: "success" as const, data: connector })
            .mockResolvedValueOnce({ status: "success" as const, data: installation });
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(completeGitHubConnectorManifest(client, { code: "code-1", state: "state-1" })).resolves.toEqual(
            connector
        );
        await expect(
            completeGitHubConnectorInstallation(client, {
                state: "state-2",
                installation_id: "installation-1",
                setup_action: "install",
            })
        ).resolves.toEqual(installation);
        expect(get).toHaveBeenNthCalledWith(1, "/connectors/github/manifest/callback?code=code-1&state=state-1");
        expect(get).toHaveBeenNthCalledWith(
            2,
            "/connectors/github/install/callback?state=state-2&installation_id=installation-1&setup_action=install"
        );
    });

    test("starts connector installation flow for a managed owner", async () => {
        const get = vi.fn(async () => ({
            status: "success" as const,
            data: { redirectUrl: "https://github.com/apps/kiwi/install" },
        }));
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(startConnectorConnect(client, connector.id, { teamId: "team-1" })).resolves.toEqual({
            redirectUrl: "https://github.com/apps/kiwi/install",
        });
        expect(get).toHaveBeenCalledWith("/connectors/connector-1/connect?teamId=team-1");
    });

    test("fetches installation repositories and encoded branches", async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({ status: "success" as const, data: [installation] })
            .mockResolvedValueOnce({ status: "success" as const, data: [repository] })
            .mockResolvedValueOnce({ status: "success" as const, data: [branch] });
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(fetchConnectorInstallations(client, connector.id)).resolves.toEqual([installation]);
        await expect(fetchConnectorRepositories(client, connector.id, installation.id)).resolves.toEqual([repository]);
        await expect(fetchConnectorBranches(client, connector.id, installation.id, repository.id)).resolves.toEqual([
            branch,
        ]);
        expect(get).toHaveBeenNthCalledWith(1, "/connectors/connector-1/installations");
        expect(get).toHaveBeenNthCalledWith(2, "/connectors/connector-1/repositories?installationId=installation-1");
        expect(get).toHaveBeenNthCalledWith(
            3,
            "/connectors/connector-1/repositories/repo%2F1/branches?installationId=installation-1"
        );
    });

    test("creates and syncs repository graphs", async () => {
        const graph = {
            id: "row-1",
            name: "app",
            description: null,
            organizationId: "org-1",
            teamId: null,
            userId: null,
            graphId: "graph-1",
            hidden: false,
            state: "updating" as const,
        };
        const input = {
            connectorInstallationId: installation.id,
            repositoryId: repository.id,
            repositoryFullName: repository.fullName,
            repositoryHtmlUrl: repository.htmlUrl,
            branch: branch.name,
            name: "app",
            owner: { kind: "organization" as const },
        };
        const post = vi
            .fn()
            .mockResolvedValueOnce({ status: "success" as const, data: { graph, binding, workflowRunId: "run-1" } })
            .mockResolvedValueOnce({ status: "success" as const, data: { binding, workflowRunId: "run-2" } });
        const client = { baseURL: "/api", post } as unknown as KiwiApiClient;

        await expect(createRepositoryGraph(client, connector.id, input)).resolves.toEqual({
            graph,
            binding,
            workflowRunId: "run-1",
        });
        await expect(syncRepositoryGraphBinding(client, binding.id)).resolves.toEqual({
            binding,
            workflowRunId: "run-2",
        });
        expect(post).toHaveBeenNthCalledWith(1, "/connectors/connector-1/repository-graphs", input);
        expect(post).toHaveBeenNthCalledWith(2, "/repository-graph-bindings/binding-1/sync");
    });
});
