import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
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
    appSlug: "kiwi-app",
};

const insertValues: Array<Record<string, unknown>> = [];
const conflictConfigs: Array<Record<string, unknown>> = [];
const installationAccountCalls: string[] = [];
const listBranchesCalls: Array<Record<string, unknown>> = [];
const listRepositoriesCalls: Array<Record<string, unknown>> = [];
const updateValues: Array<Record<string, unknown>> = [];
const workflowInputs: Array<Record<string, unknown>> = [];
const signedStates: Array<Record<string, unknown>> = [];
const organizationAdminChecks: Array<string | undefined> = [];
let installationConnectorId = "connector-1";
let teamAccessOrganizationId = "org-1";
let verifiedState: Record<string, unknown> = {
    purpose: "github-installation",
    userId: "user-1",
    connectorId: "connector-1",
    organizationId: "org-1",
    createdAt: Date.now(),
};
let workflowError: Error | null = null;

type MockDb = {
    insert: () => {
        values: (values: Record<string, unknown>) => {
            onConflictDoUpdate: (config: Record<string, unknown>) => {
                returning: () => Promise<Array<Record<string, unknown>>>;
            };
            returning: () => Promise<Array<Record<string, unknown>>>;
        };
    };
    update: () => {
        set: (values: Record<string, unknown>) => {
            where: () => {
                returning: () => Promise<never[]>;
            };
        };
    };
    select: () => {
        from: () => {
            orderBy: () => Promise<never[]>;
        };
    };
    transaction: (callback: (tx: MockDb) => unknown) => Promise<unknown>;
};

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia().derive({ as: "scoped" }, () => ({
        user: authUser,
    })),
}));

mock.module("../../lib/graph/access", () => ({
    assertCanCreateTeamGraph: () => Effect.succeed({ team: { id: "team-1", organizationId: teamAccessOrganizationId } }),
}));

mock.module("../../lib/team/access", () => ({
    requireOrganizationAdmin: (_user: unknown, organizationId?: string) =>
        Effect.sync(() => {
            organizationAdminChecks.push(organizationId);
            return { organizationId: organizationId ?? "org-1" };
        }),
    requireTeamGraphCreateAccess: () =>
        Effect.succeed({ organizationAdmin: true, role: "admin", team: { id: "team-1", organizationId: teamAccessOrganizationId } }),
}));

mock.module("../../lib/connector-access", () => ({
    assertCanSyncBinding: () => Effect.succeed({ binding: { id: "binding-1" } }),
    assertCanUseInstallation: () =>
        Effect.succeed({
            id: "installation-1",
            connectorId: installationConnectorId,
            provider: "github",
            organizationId: "org-1",
            teamId: null,
        }),
    assertCanViewBinding: () => Effect.succeed({ binding: { id: "binding-1" } }),
    requireActiveConnector: (id: string) => Effect.succeed({ ...connector, id }),
}));

mock.module("../../lib/connectors", () => ({
    createManifestUrl: () => "https://github.com/settings/apps/new",
    encryptCredentials: () => "encrypted",
    encryptSecret: () => "encrypted-secret",
    exchangeGitHubManifestCode: () => Effect.fail(new Error("manifest exchange not expected")),
    getGitHubConnectorInstallationAccount: (_connector: unknown, installationId: string) =>
        Effect.sync(() => {
            installationAccountCalls.push(installationId);
            return {
                login: "acme",
                type: "organization",
                repositorySelection: "selected",
            };
        }),
    listProviderBranches: (_connector: unknown, _installation: unknown, repositoryId: string) =>
        Effect.sync(() => {
            listBranchesCalls.push({ repositoryId });
            return [{ name: "main", commitSha: "commit-sha" }];
        }),
    listProviderRepositories: (connector: { id: string }, installation: { id: string }) =>
        Effect.sync(() => {
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
        }),
    signConnectorState: (state: Record<string, unknown>) => {
        signedStates.push(state);
        return "state";
    },
    toPublicConnector: (row: unknown) => row,
    toPublicInstallation: (row: unknown) => row,
    verifyConnectorState: () => verifiedState,
}));

mock.module("../../openworkflow", () => ({
    ow: {
        runWorkflow: async (_spec: unknown, input: Record<string, unknown>) => {
            workflowInputs.push(input);
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
                        returning: async () => [{ id: "installation-1", ...values, status: "active" }],
                    };
                },
                returning: async () => [{ id: "row-1", ...values }],
            };
        },
    }),
    update: () => ({
        set: (values: Record<string, unknown>) => {
            updateValues.push(values);
            return {
                where: () => ({
                    returning: async () => [],
                }),
            };
        },
    }),
    select: () => ({
        from: () => ({
            orderBy: async () => [],
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
        workflowInputs.length = 0;
        updateValues.length = 0;
        signedStates.length = 0;
        organizationAdminChecks.length = 0;
        installationConnectorId = "connector-1";
        teamAccessOrganizationId = "org-1";
        verifiedState = {
            purpose: "github-installation",
            userId: "user-1",
            connectorId: "connector-1",
            organizationId: "org-1",
            createdAt: Date.now(),
        };
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

    test("connect state uses requested organization after admin check", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/connect?organizationId=org-2")
        );

        expect(response.status).toBe(200);
        expect(organizationAdminChecks).toEqual(["org-2"]);
        expect(signedStates[0]).toMatchObject({
            purpose: "github-installation",
            userId: "user-1",
            connectorId: "connector-1",
            organizationId: "org-2",
        });
        expect(signedStates[0]).not.toHaveProperty("teamId");
    });

    test("connect state derives organization from team access", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/connect?teamId=team-1&organizationId=org-2")
        );

        expect(response.status).toBe(200);
        expect(organizationAdminChecks).toEqual([]);
        expect(signedStates[0]).toMatchObject({
            purpose: "github-installation",
            userId: "user-1",
            connectorId: "connector-1",
            organizationId: "org-1",
            teamId: "team-1",
        });
    });

    test("rejects install callback when team state crosses organization", async () => {
        verifiedState = {
            purpose: "github-installation",
            userId: "user-1",
            connectorId: "connector-1",
            organizationId: "org-2",
            teamId: "team-1",
            createdAt: Date.now(),
        };

        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/github/install/callback?state=state&installation_id=99")
        );

        expect(response.status).toBe(403);
        expect(insertValues).toEqual([]);
    });

    test("creates generic resource binding rows and enqueues initial sync with a version id", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/repository-graphs", {
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

        expect(response.status).toBe(200);
        expect(insertValues[1]).toMatchObject({
            provider: "github",
            resourceKind: "git-repository",
            providerResourceId: "repo-1",
            resourceDisplayName: "acme/app",
            resourceWebUrl: "https://github.com/acme/app",
            versionName: "main",
            lastSeenVersionId: "commit-sha",
            syncStatus: "pending",
        });
        expect(workflowInputs[0]).toEqual({
            bindingId: "row-1",
            reason: "initial",
            versionId: "commit-sha",
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
