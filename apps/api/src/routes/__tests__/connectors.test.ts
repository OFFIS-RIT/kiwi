import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

const authUser = {
    id: "user-1",
    activeOrganizationId: "org-1",
    activeTeamId: null,
    isSystemAdmin: false,
};

const connector = {
    id: "connector-1",
    provider: "github",
    status: "active",
    encryptedCredentials: "encrypted",
};

const insertValues: Array<Record<string, unknown>> = [];
const conflictConfigs: Array<Record<string, unknown>> = [];
const installationAccountCalls: string[] = [];
const listBranchesCalls: Array<Record<string, unknown>> = [];
const listRepositoriesCalls: Array<Record<string, unknown>> = [];
const updateValues: Array<Record<string, unknown>> = [];
let installationConnectorId = "connector-1";
let workflowError: Error | null = null;

type MockDb = {
    insert: () => {
        values: (values: Record<string, unknown>) => {
            onConflictDoUpdate: (config: Record<string, unknown>) => {
                returning: () => Array<Record<string, unknown>>;
            };
            returning: () => Array<Record<string, unknown>>;
        };
    };
    update: () => {
        set: (values: Record<string, unknown>) => {
            where: () => {
                returning: () => never[];
            };
        };
    };
    select: () => {
        from: () => {
            orderBy: () => never[];
        };
    };
    transaction: (callback: (tx: MockDb) => unknown) => Promise<unknown>;
};

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia().derive({ as: "scoped" }, () => ({
        user: authUser,
    })),
}));

mock.module("../../lib/graph-access", () => ({
    assertCanCreateTeamGraph: async () => ({ team: { id: "team-1", organizationId: "org-1" } }),
    assertCanCreateTopLevelGraph: async () => ({ organizationId: "org-1" }),
}));

mock.module("../../lib/connector-access", () => ({
    assertCanSyncBinding: async () => ({ binding: { id: "binding-1" } }),
    assertCanUseInstallation: async () => ({
        id: "installation-1",
        connectorId: installationConnectorId,
        provider: "github",
        organizationId: "org-1",
        teamId: null,
    }),
    assertCanViewBinding: async () => ({ binding: { id: "binding-1" } }),
    requireActiveConnector: async (id: string) => ({ ...connector, id }),
}));

mock.module("../../lib/connectors", () => ({
    createManifestUrl: () => "https://github.com/settings/apps/new",
    encryptCredentials: () => "encrypted",
    encryptSecret: () => "encrypted-secret",
    exchangeGitHubManifestCode: async () => {
        throw new Error("manifest exchange not expected");
    },
    getGitHubConnectorInstallationAccount: async (_connector: unknown, installationId: string) => {
        installationAccountCalls.push(installationId);
        return {
            login: "acme",
            type: "organization",
            repositorySelection: "selected",
        };
    },
    listProviderBranches: async (_connector: unknown, _installation: unknown, repositoryId: string) => {
        listBranchesCalls.push({ repositoryId });
        return [{ name: "main", commitSha: "commit-sha" }];
    },
    listProviderRepositories: async (connector: { id: string }, installation: { id: string }) => {
        listRepositoriesCalls.push({ connectorId: connector.id, installationId: installation.id });
        return [
            {
                id: "repo-1",
                provider: "github",
                fullName: "acme/app",
                name: "app",
                htmlUrl: "https://github.com/acme/app",
                defaultBranch: "main",
                private: true,
            },
        ];
    },
    signConnectorState: () => "state",
    toPublicConnector: (row: unknown) => row,
    toPublicInstallation: (row: unknown) => row,
    verifyConnectorState: () => ({
        purpose: "github-installation",
        userId: "user-1",
        connectorId: "connector-1",
        organizationId: "org-1",
        createdAt: Date.now(),
    }),
}));

mock.module("../../openworkflow", () => ({
    ow: {
        runWorkflow: async () => {
            if (workflowError) {
                throw workflowError;
            }
            return { workflowRun: { id: "run-1" } };
        },
    },
}));

const mockDb: MockDb = {
    insert: () => ({
        values: (values: Record<string, unknown>) => {
            insertValues.push(values);
            return {
                onConflictDoUpdate: (config: Record<string, unknown>) => {
                    conflictConfigs.push(config);
                    return {
                        returning: () => [{ id: "installation-1", ...values, status: "active" }],
                    };
                },
                returning: () => [{ id: "row-1", ...values }],
            };
        },
    }),
    update: () => ({
        set: (values: Record<string, unknown>) => {
            updateValues.push(values);
            return {
                where: () => ({
                    returning: () => [],
                }),
            };
        },
    }),
    select: () => ({
        from: () => ({
            orderBy: () => [],
        }),
    }),
    transaction: async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb),
};

mock.module("@kiwi/db", () => ({ db: mockDb }));

// Dynamic import is required so module mocks are installed before the route module is evaluated.
const { connectorRoute, repositoryGraphBindingRoute } = await import("../connectors");

describe("connector route", () => {
    beforeEach(() => {
        insertValues.length = 0;
        conflictConfigs.length = 0;
        installationAccountCalls.length = 0;
        listBranchesCalls.length = 0;
        listRepositoriesCalls.length = 0;
        updateValues.length = 0;
        installationConnectorId = "connector-1";
        workflowError = null;
    });

    test("stores GitHub installation account metadata and targets org-scope upserts", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/github/install/callback?state=state&installation_id=99")
        );

        expect(response.status).toBe(200);
        expect(installationAccountCalls).toEqual(["99"]);
        expect(insertValues[0]).toMatchObject({
            connectorId: "connector-1",
            provider: "github",
            providerInstallationId: "99",
            providerAccountLogin: "acme",
            providerAccountType: "organization",
            organizationId: "org-1",
            teamId: null,
            repositorySelection: "selected",
        });
        expect(conflictConfigs[0]?.target).toHaveLength(3);
        expect(conflictConfigs[0]).toHaveProperty("targetWhere");
        expect(conflictConfigs[0]?.set).toMatchObject({
            providerAccountLogin: "acme",
            providerAccountType: "organization",
            repositorySelection: "selected",
            status: "active",
            installedByUserId: "user-1",
        });
    });

    test("marks manual repository graph sync failed when workflow enqueue fails", async () => {
        workflowError = new Error("enqueue failed");

        const response = await repositoryGraphBindingRoute.handle(
            new Request("http://localhost/repository-graph-bindings/binding-1/sync", { method: "POST" })
        );

        expect(response.status).toBe(400);
        expect(updateValues).toContainEqual({ syncStatus: "pending", syncErrorCode: null });
        expect(updateValues).toContainEqual({ syncStatus: "failed", syncErrorCode: "enqueue_failed" });
    });

    test("rejects repository listing when installation belongs to another connector", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-2/repositories?installationId=installation-1")
        );

        expect(response.status).toBe(403);
        expect(listRepositoriesCalls).toEqual([]);
    });

    test("rejects branch listing when installation belongs to another connector", async () => {
        const response = await connectorRoute.handle(
            new Request(
                "http://localhost/connectors/connector-2/repositories/repo-1/branches?installationId=installation-1"
            )
        );

        expect(response.status).toBe(403);
        expect(listBranchesCalls).toEqual([]);
    });

    test("rejects repository graph creation when installation belongs to another connector", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-2/repository-graphs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    connectorInstallationId: "installation-1",
                    repositoryId: "repo-1",
                    repositoryFullName: "acme/app",
                    repositoryHtmlUrl: "https://github.com/acme/app",
                    branch: "main",
                    name: "App",
                    owner: { kind: "organization" },
                }),
            })
        );

        expect(response.status).toBe(403);
        expect(listRepositoriesCalls).toEqual([]);
    });
});
