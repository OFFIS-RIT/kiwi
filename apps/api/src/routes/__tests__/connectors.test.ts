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
const updateValues: Array<Record<string, unknown>> = [];
let workflowError: Error | null = null;

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
    assertCanUseInstallation: async () => ({ id: "installation-1", provider: "github" }),
    assertCanViewBinding: async () => ({ binding: { id: "binding-1" } }),
    requireActiveConnector: async () => connector,
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
    listProviderBranches: async () => [],
    listProviderRepositories: async () => [],
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

mock.module("@kiwi/db", () => ({
    db: {
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
    },
}));

// Dynamic import is required so module mocks are installed before the route module is evaluated.
const { connectorRoute, repositoryGraphBindingRoute } = await import("../connectors");

describe("connector route", () => {
    beforeEach(() => {
        insertValues.length = 0;
        conflictConfigs.length = 0;
        installationAccountCalls.length = 0;
        updateValues.length = 0;
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
});
