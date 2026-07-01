import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
const listChildrenCalls: Array<Record<string, unknown>> = [];
const updateValues: Array<Record<string, unknown>> = [];
const workflowInputs: Array<Record<string, unknown>> = [];
const signedStates: Array<Record<string, unknown>> = [];
const organizationAdminChecks: Array<string | undefined> = [];
let installationConnectorId = "connector-1";
let activeConnectorProvider = "github";
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
    assertCanCreateTeamGraph: () =>
        Effect.succeed({ team: { id: "team-1", organizationId: teamAccessOrganizationId } }),
}));

mock.module("../../lib/team/access", () => ({
    requireOrganizationAdmin: (_user: unknown, organizationId?: string) =>
        Effect.sync(() => {
            organizationAdminChecks.push(organizationId);
            return { organizationId: organizationId ?? "org-1" };
        }),
    requireTeamGraphCreateAccess: () =>
        Effect.succeed({
            organizationAdmin: true,
            role: "admin",
            team: { id: "team-1", organizationId: teamAccessOrganizationId },
        }),
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
    requireActiveConnector: (id: string) => Effect.succeed({ ...connector, provider: activeConnectorProvider, id }),
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
    listProviderResources: (connector: { id: string }, installation: { id: string }) =>
        Effect.sync(() => {
            listRepositoriesCalls.push({ connectorId: connector.id, installationId: installation.id });
            return [
                {
                    id: "repo-1",
                    provider: "github",
                    kind: "git-repository",
                    displayName: "acme/app",
                    webUrl: "https://github.com/acme/app",
                    defaultBranch: "main",
                    private: true,
                },
            ];
        }),
    listProviderChildren: (connector: { id: string }, installation: { id: string }, parentId?: string) =>
        Effect.sync(() => {
            listChildrenCalls.push({ connectorId: connector.id, installationId: installation.id, parentId });
            return [
                {
                    id: "folder-docs",
                    parentId: parentId ?? null,
                    name: "Docs",
                    path: "Team/Docs",
                    kind: "folder",
                    webUrl: "https://cloud.example.com/apps/files/?dir=%2FTeam%2FDocs",
                },
                {
                    id: "file-readme",
                    parentId: parentId ?? null,
                    name: "readme.txt",
                    path: "Team/readme.txt",
                    kind: "file",
                    webUrl: "https://cloud.example.com/apps/files/?dir=%2FTeam%2Freadme.txt",
                    size: 12,
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

mock.module("../../workflow", () => ({
    wo: {
        runWorkflow: async (_spec: unknown, input: Record<string, unknown>) => {
            workflowInputs.push(input);
            if (workflowError) {
                throw workflowError;
            }
            return { workflowRun: { id: "run-1" } };
        },
    },
}));
function runTransactionResult<T>(result: T | PromiseLike<T> | Effect.Effect<T>) {
    return Effect.isEffect(result) ? Effect.runPromise(result) : result;
}

const transactionDb = {
    insert: () => ({
        values: (values: Record<string, unknown>) => {
            insertValues.push(values);
            return {
                returning: () => Effect.succeed([{ id: "row-1", ...values }]),
            };
        },
    }),
};

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
    transaction: async (callback: (tx: typeof mockDb) => unknown) =>
        runTransactionResult(callback(transactionDb as unknown as MockDb)),
};

class MockDatabaseError extends Error {
    constructor(options?: { cause?: unknown }) {
        super("database error");
        this.cause = options?.cause;
    }
}

function runMockDbEffect(thunk: (database: MockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(mockDb);
    return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
}

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed(mockDb),
    DatabaseError: MockDatabaseError,
    DatabaseLayer: Layer.empty,
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
    tryDb: runMockDbEffect,
    tryDbVoid: (thunk: (database: MockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) =>
        Effect.asVoid(runMockDbEffect(thunk)),
}));

mock.module("@kiwi/db", () => ({ betterAuthDb: mockDb, db: mockDb }));

// Dynamic import is required so module mocks are installed before the route module is evaluated.
const { connectorRoute, connectorResourceBindingRoute } = await import("../connectors");

describe("connector route", () => {
    beforeEach(() => {
        insertValues.length = 0;
        conflictConfigs.length = 0;
        installationAccountCalls.length = 0;
        listBranchesCalls.length = 0;
        listRepositoriesCalls.length = 0;
        listChildrenCalls.length = 0;
        activeConnectorProvider = "github";
        workflowInputs.length = 0;
        updateValues.length = 0;
        signedStates.length = 0;
        organizationAdminChecks.length = 0;
        authUser.isSystemAdmin = false;
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

    test("creates a Nextcloud connector app for system admins", async () => {
        authUser.isSystemAdmin = true;

        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/nextcloud", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    name: "Nextcloud",
                    slug: "nextcloud",
                    baseUrl: "https://cloud.example.com/remote.php/dav/",
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(insertValues[0]).toMatchObject({
            provider: "nextcloud",
            name: "Nextcloud",
            slug: "nextcloud",
            status: "active",
            encryptedCredentials: "encrypted",
            webhookSecretEncrypted: "encrypted-secret",
            createdByUserId: "user-1",
        });
    });

    test("creates a SharePoint connector app for system admins", async () => {
        authUser.isSystemAdmin = true;

        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/sharepoint", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    name: "SharePoint",
                    slug: "sharepoint",
                    tenantId: "tenant-1",
                    clientId: "client-1",
                    clientSecret: "secret-1",
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(insertValues[0]).toMatchObject({
            provider: "sharepoint",
            name: "SharePoint",
            slug: "sharepoint",
            status: "active",
            encryptedCredentials: "encrypted",
            webhookSecretEncrypted: "encrypted-secret",
            createdByUserId: "user-1",
        });
    });

    test("creates a team-scoped Nextcloud folder installation for team admins", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/nextcloud/installations", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    username: "alice",
                    appPassword: "app-password",
                    folderPath: "/Team",
                    owner: { kind: "team", teamId: "team-1" },
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(insertValues[0]).toMatchObject({
            connectorId: "connector-1",
            provider: "nextcloud",
            providerInstallationId: "alice:Team",
            providerAccountLogin: "alice",
            providerAccountType: "user",
            subjectKind: "team",
            subjectTeamId: "team-1",
            organizationId: "org-1",
            teamId: "team-1",
            installedByUserId: "user-1",
            encryptedCredentials: "encrypted",
            repositorySelection: "selected",
            status: "active",
        });
        expect(conflictConfigs[0]?.target).toHaveLength(3);
        expect(conflictConfigs[0]).toHaveProperty("targetWhere");
        expect(conflictConfigs[0]?.set).toMatchObject({
            providerAccountLogin: "alice",
            providerAccountType: "user",
            encryptedCredentials: "encrypted",
            repositorySelection: "selected",
            status: "active",
            installedByUserId: "user-1",
        });
    });

    test("creates a team-scoped SharePoint folder installation for team admins", async () => {
        activeConnectorProvider = "sharepoint";
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/sharepoint/installations", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    siteId: "site-1",
                    driveId: "drive-1",
                    folderPath: "/Team",
                    folderId: "folder-team",
                    owner: { kind: "team", teamId: "team-1" },
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(insertValues[0]).toMatchObject({
            connectorId: "connector-1",
            provider: "sharepoint",
            providerInstallationId: "site-1:drive-1:folder-team",
            providerAccountLogin: "site-1",
            providerAccountType: "organization",
            subjectKind: "team",
            subjectTeamId: "team-1",
            organizationId: "org-1",
            teamId: "team-1",
            installedByUserId: "user-1",
            encryptedCredentials: "encrypted",
            repositorySelection: "selected",
            status: "active",
        });
        expect(conflictConfigs[0]?.target).toHaveLength(3);
        expect(conflictConfigs[0]).toHaveProperty("targetWhere");
        expect(conflictConfigs[0]?.set).toMatchObject({
            providerAccountLogin: "site-1",
            providerAccountType: "organization",
            encryptedCredentials: "encrypted",
            repositorySelection: "selected",
            status: "active",
            installedByUserId: "user-1",
        });
    });

    test("discovers repositories at the connector root", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/discover?installationId=installation-1")
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(listRepositoriesCalls).toEqual([{ connectorId: "connector-1", installationId: "installation-1" }]);
        expect(body).toMatchObject({
            status: "success",
            data: [
                {
                    provider: "github",
                    resourceKind: "git-repository",
                    resourceId: "repo-1",
                    itemKind: "resource",
                    canBind: true,
                    canHaveChildren: false,
                    resourceDisplayName: "acme/app",
                    resourceWebUrl: "https://github.com/acme/app",
                },
            ],
        });
    });

    test("discovers hierarchical connector children below a selected folder", async () => {
        activeConnectorProvider = "nextcloud";
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/discover?installationId=installation-1&parentId=Team")
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(listChildrenCalls).toEqual([
            { connectorId: "connector-1", installationId: "installation-1", parentId: "Team" },
        ]);
        expect(body).toMatchObject({
            status: "success",
            data: [
                {
                    id: "folder-docs",
                    provider: "nextcloud",
                    resourceKind: "folder",
                    resourceId: "folder-docs",
                    providerItemId: "folder-docs",
                    path: "Team/Docs",
                    itemKind: "folder",
                    parentId: "Team",
                    canBind: true,
                    canHaveChildren: true,
                    resourceDisplayName: "Docs",
                    resourceWebUrl: "https://cloud.example.com/apps/files/?dir=%2FTeam%2FDocs",
                },
                {
                    id: "file-readme",
                    provider: "nextcloud",
                    resourceKind: "file",
                    resourceId: "file-readme",
                    providerItemId: "file-readme",
                    path: "Team/readme.txt",
                    itemKind: "file",
                    parentId: "Team",
                    canBind: true,
                    canHaveChildren: false,
                    size: 12,
                },
            ],
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
            new Request("http://localhost/connectors/connector-1/resource-graphs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    connectorInstallationId: "installation-1",
                    resourceKind: "git-repository",
                    resourceId: "repo-1",
                    resourceDisplayName: "acme/app",
                    resourceWebUrl: "https://github.com/acme/app",
                    versionName: "main",
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

    test("rejects file bindings for git repository connectors", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/resource-graphs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    connectorInstallationId: "installation-1",
                    resourceKind: "file",
                    resourceId: "src/index.ts",
                    resourceDisplayName: "index.ts",
                    resourceWebUrl: "https://github.com/acme/app/blob/main/src/index.ts",
                    name: "index.ts",
                    owner: { kind: "organization" },
                }),
            })
        );

        expect(response.status).toBe(400);
        expect(insertValues).toEqual([]);
        expect(workflowInputs).toEqual([]);
    });

    test("creates provider-neutral file bindings for storage connectors", async () => {
        activeConnectorProvider = "nextcloud";
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/resource-graphs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    connectorInstallationId: "installation-1",
                    resourceKind: "file",
                    resourceId: "opaque-file-id",
                    resourcePath: "Team/readme.txt",
                    providerItemId: "file-readme",
                    resourceDisplayName: "readme.txt",
                    resourceWebUrl: "https://cloud.example.com/apps/files/?dir=%2FTeam%2Freadme.txt",
                    name: "readme.txt",
                    owner: { kind: "organization" },
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(insertValues[1]).toMatchObject({
            provider: "nextcloud",
            resourceKind: "file",
            providerResourceId: "opaque-file-id",
            resourceDisplayName: "readme.txt",
            syncStatus: "pending",
        });
        const fileMetadata = insertValues[1]?.resourceMetadata;
        expect(typeof fileMetadata === "string" ? JSON.parse(fileMetadata) : fileMetadata).toEqual({
            resourcePath: "Team/readme.txt",
            providerItemId: "file-readme",
        });
        expect(workflowInputs[0]).toEqual({
            bindingId: "row-1",
            reason: "initial",
        });
    });

    test("creates provider-neutral folder bindings without a branch version lookup", async () => {
        activeConnectorProvider = "nextcloud";
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-1/resource-graphs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    connectorInstallationId: "installation-1",
                    resourceKind: "folder",
                    resourceId: "opaque-folder-id",
                    resourcePath: "Team",
                    providerItemId: "folder-team",
                    resourceDisplayName: "Team Drive",
                    resourceWebUrl: "https://storage.test/team-drive",
                    metadata: { driveType: "team" },
                    webhookEnabled: false,
                    syncEnabled: true,
                    name: "Team Drive",
                    owner: { kind: "organization" },
                }),
            })
        );

        expect(response.status).toBe(200);
        expect(listBranchesCalls).toEqual([]);
        expect(insertValues[1]).toMatchObject({
            provider: "nextcloud",
            resourceKind: "folder",
            providerResourceId: "opaque-folder-id",
            resourceDisplayName: "Team Drive",
            resourceWebUrl: "https://storage.test/team-drive",
            versionName: null,
            syncEnabled: true,
            webhookEnabled: false,
            syncStatus: "pending",
        });
        const metadata = insertValues[1]?.resourceMetadata;
        expect(typeof metadata === "string" ? JSON.parse(metadata) : metadata).toEqual({
            driveType: "team",
            resourcePath: "Team",
            providerItemId: "folder-team",
        });
        expect(workflowInputs[0]).toEqual({
            bindingId: "row-1",
            reason: "initial",
        });
        expect(updateValues).toContainEqual({ syncEnabled: false });
    });

    test("marks manual repository graph sync failed when workflow enqueue fails", async () => {
        workflowError = new Error("enqueue failed");

        const response = await connectorResourceBindingRoute.handle(
            new Request("http://localhost/connector-resource-bindings/binding-1/sync", { method: "POST" })
        );

        expect(response.status).toBe(400);
        expect(updateValues).toContainEqual({ syncStatus: "pending", syncErrorCode: null });
        expect(updateValues).toContainEqual({ syncStatus: "failed", syncErrorCode: "enqueue_failed" });
    });

    test("rejects discovery when installation belongs to another connector", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-2/discover?installationId=installation-1")
        );

        expect(response.status).toBe(403);
        expect(listRepositoriesCalls).toEqual([]);
        expect(listChildrenCalls).toEqual([]);
    });

    test("rejects repository listing when installation belongs to another connector", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-2/resources?installationId=installation-1")
        );

        expect(response.status).toBe(403);
        expect(listRepositoriesCalls).toEqual([]);
    });

    test("rejects branch listing when installation belongs to another connector", async () => {
        const response = await connectorRoute.handle(
            new Request(
                "http://localhost/connectors/connector-2/resources/repo-1/versions?installationId=installation-1"
            )
        );

        expect(response.status).toBe(403);
        expect(listBranchesCalls).toEqual([]);
    });

    test("rejects repository graph creation when installation belongs to another connector", async () => {
        const response = await connectorRoute.handle(
            new Request("http://localhost/connectors/connector-2/resource-graphs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    connectorInstallationId: "installation-1",
                    resourceKind: "git-repository",
                    resourceId: "repo-1",
                    resourceDisplayName: "acme/app",
                    resourceWebUrl: "https://github.com/acme/app",
                    versionName: "main",
                    name: "App",
                    owner: { kind: "organization" },
                }),
            })
        );

        expect(response.status).toBe(403);
        expect(listRepositoriesCalls).toEqual([]);
    });
});
