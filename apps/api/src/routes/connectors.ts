import { ulid } from "ulid";
import { db } from "@kiwi/db";
import {
    connectorInstallationsTable,
    connectorsTable,
    repositoryGraphBindingsTable,
    type ConnectorProvider,
} from "@kiwi/db/tables/connectors";
import { graphTable } from "@kiwi/db/tables/graph";
import { syncRepositoryGraphSpec } from "@kiwi/worker/sync-repository-graph-spec";
import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import Elysia from "elysia";
import z from "zod";
import { assertCanCreateTeamGraph, assertCanCreateTopLevelGraph } from "../lib/graph-access";
import {
    assertCanSyncBinding,
    assertCanUseInstallation,
    assertCanViewBinding,
    requireActiveConnector,
} from "../lib/connector-access";
import {
    createManifestUrl,
    encryptCredentials,
    encryptSecret,
    exchangeGitHubManifestCode,
    getGitHubConnectorInstallationAccount,
    listProviderBranches,
    listProviderRepositories,
    signConnectorState,
    toPublicConnector,
    toPublicInstallation,
    verifyConnectorState,
} from "../lib/connectors";
import { ow } from "../openworkflow";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

const githubManifestStartSchema = z.object({
    name: z.string().trim().min(1),
});

const gitLabCreateSchema = z.object({
    name: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    baseUrl: z.string().trim().url(),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    webhookSecret: z.string().trim().min(1),
});

const patchConnectorSchema = z.object({
    name: z.string().trim().min(1).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    webhookSecret: z.string().trim().min(1).optional(),
});

const connectQuerySchema = z.object({
    organizationId: z.string().trim().min(1).optional(),
    teamId: z.string().trim().min(1).optional(),
});

const installCallbackQuerySchema = z.object({
    state: z.string().trim().min(1),
    installation_id: z.string().trim().min(1),
    setup_action: z.string().trim().optional(),
});

const repositoryQuerySchema = z.object({
    installationId: z.string().trim().min(1),
});

const connectorOwnerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("organization") }),
    z.object({ kind: z.literal("team"), teamId: z.string().trim().min(1) }),
]);

const createRepositoryGraphSchema = z.object({
    connectorInstallationId: z.string().trim().min(1),
    repositoryId: z.string().trim().min(1),
    repositoryFullName: z.string().trim().min(1),
    repositoryHtmlUrl: z.string().trim().url(),
    branch: z.string().trim().min(1),
    name: z.string().trim().min(1),
    owner: connectorOwnerSchema,
});

type RouteStatus = (code: number, body: unknown) => unknown;

function mapConnectorError(status: RouteStatus, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }
    const message = error.message.replace(/^Unhandled exception: /u, "");
    if (message === API_ERROR_CODES.UNAUTHORIZED) {
        return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
    }
    if (message === API_ERROR_CODES.FORBIDDEN) {
        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }
    if (message === API_ERROR_CODES.GRAPH_NOT_FOUND) {
        return status(404, errorResponse("Not found", API_ERROR_CODES.GRAPH_NOT_FOUND));
    }
    return status(400, errorResponse(message || "Invalid connector request", API_ERROR_CODES.INVALID_CHAT_REQUEST));
}

async function runConnectorAction<T>(options: {
    user: AuthUser | null | undefined;
    status: RouteStatus;
    action: (user: AuthUser) => Promise<T>;
}) {
    if (!options.user) {
        return options.status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
    }
    const result = await Result.tryPromise(async () => options.action(options.user!));
    if (result.isErr()) {
        return mapConnectorError(options.status, result.error);
    }
    return options.status(200, successResponse(result.value));
}

function assertSystemAdmin(user: AuthUser) {
    if (!user.isSystemAdmin) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

function repositoryMatches(repository: { id: string; fullName: string }, requestedId: string) {
    return repository.id === requestedId || repository.fullName === requestedId;
}

function assertInstallationBelongsToConnector(installation: { connectorId: string }, connectorId: string) {
    if (installation.connectorId !== connectorId) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

function toBindingResponse(binding: typeof repositoryGraphBindingsTable.$inferSelect) {
    return {
        id: binding.id,
        graphId: binding.graphId,
        connectorInstallationId: binding.connectorInstallationId,
        provider: binding.provider as ConnectorProvider,
        providerRepositoryId: binding.providerRepositoryId,
        repositoryFullName: binding.repositoryFullName,
        repositoryHtmlUrl: binding.repositoryHtmlUrl,
        branch: binding.branch,
        lastSeenCommitSha: binding.lastSeenCommitSha,
        lastSyncedCommitSha: binding.lastSyncedCommitSha,
        syncStatus: binding.syncStatus,
        syncErrorCode: binding.syncErrorCode,
        webhookEnabled: binding.webhookEnabled,
        createdAt: binding.createdAt?.toISOString() ?? null,
        updatedAt: binding.updatedAt?.toISOString() ?? null,
    };
}

export const connectorRoute = new Elysia({ prefix: "/connectors" })
    .use(authMiddleware)
    .get("/", async ({ status, user }) =>
        runConnectorAction({
            user,
            status,
            action: async (currentUser) => {
                const rows = await db.select().from(connectorsTable).orderBy(asc(connectorsTable.name));
                return rows
                    .filter((row) => currentUser.isSystemAdmin || row.status === "active")
                    .map(toPublicConnector);
            },
        })
    )
    .post(
        "/github/manifest/start",
        async ({ body, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    assertSystemAdmin(currentUser);
                    const state = signConnectorState({ purpose: "github-manifest", userId: currentUser.id });
                    return { state, manifestUrl: createManifestUrl(state, body.name.trim()) };
                },
            }),
        { body: githubManifestStartSchema }
    )
    .get(
        "/github/manifest/callback",
        async ({ query, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    assertSystemAdmin(currentUser);
                    if (!verifyConnectorState(query.state, "github-manifest", currentUser.id)) {
                        throw new Error(API_ERROR_CODES.FORBIDDEN);
                    }
                    const app = await exchangeGitHubManifestCode(query.code);
                    const slug = app.slug ?? `github-${String(app.id)}`;
                    const [connector] = await db
                        .insert(connectorsTable)
                        .values({
                            provider: "github",
                            name: app.name,
                            slug,
                            appId: String(app.id),
                            appSlug: slug,
                            clientId: app.client_id ?? null,
                            encryptedCredentials: encryptCredentials({
                                provider: "github",
                                appId: String(app.id),
                                privateKeyPem: app.pem,
                                clientId: app.client_id,
                                clientSecret: app.client_secret,
                            }),
                            webhookSecretEncrypted: encryptSecret(app.webhook_secret ?? ulid()),
                            createdByUserId: currentUser.id,
                        })
                        .returning();
                    return toPublicConnector(connector);
                },
            }),
        { query: z.object({ code: z.string().trim().min(1), state: z.string().trim().min(1) }) }
    )
    .post(
        "/gitlab",
        async ({ body, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    assertSystemAdmin(currentUser);
                    const [connector] = await db
                        .insert(connectorsTable)
                        .values({
                            provider: "gitlab",
                            name: body.name,
                            slug: body.slug,
                            status: "disabled",
                            appId: body.clientId,
                            clientId: body.clientId,
                            encryptedCredentials: encryptCredentials({
                                provider: "gitlab",
                                baseUrl: body.baseUrl,
                                clientId: body.clientId,
                                clientSecret: body.clientSecret,
                            }),
                            webhookSecretEncrypted: encryptSecret(body.webhookSecret),
                            createdByUserId: currentUser.id,
                        })
                        .returning();
                    return toPublicConnector(connector);
                },
            }),
        { body: gitLabCreateSchema }
    )
    .patch(
        "/:id",
        async ({ params, body, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    assertSystemAdmin(currentUser);
                    const [connector] = await db
                        .update(connectorsTable)
                        .set({
                            ...(body.name ? { name: body.name } : {}),
                            ...(body.status ? { status: body.status } : {}),
                            ...(body.webhookSecret
                                ? { webhookSecretEncrypted: encryptSecret(body.webhookSecret) }
                                : {}),
                        })
                        .where(eq(connectorsTable.id, params.id))
                        .returning();
                    if (!connector) {
                        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
                    }
                    return toPublicConnector(connector);
                },
            }),
        { body: patchConnectorSchema }
    )
    .get(
        "/:id/connect",
        async ({ params, query, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    const connector = await requireActiveConnector(params.id);
                    if (query.teamId) {
                        await assertCanCreateTeamGraph(currentUser, query.teamId);
                    } else {
                        await assertCanCreateTopLevelGraph(currentUser);
                    }
                    const state = signConnectorState({
                        purpose: connector.provider === "github" ? "github-installation" : "gitlab-oauth",
                        userId: currentUser.id,
                        connectorId: connector.id,
                        organizationId: query.organizationId ?? currentUser.activeOrganizationId ?? undefined,
                        teamId: query.teamId,
                    });
                    if (connector.provider === "github") {
                        if (!connector.appSlug) {
                            throw new Error(API_ERROR_CODES.FORBIDDEN);
                        }
                        return {
                            redirectUrl: `https://github.com/apps/${connector.appSlug}/installations/new?state=${encodeURIComponent(state)}`,
                        };
                    }
                    throw new Error("GitLab connector installations are disabled until OAuth flow support lands.");
                },
            }),
        { query: connectQuerySchema }
    )
    .get(
        "/github/install/callback",
        async ({ query, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    const state = verifyConnectorState(query.state, "github-installation", currentUser.id);
                    if (!state?.connectorId) {
                        throw new Error(API_ERROR_CODES.FORBIDDEN);
                    }
                    const connector = await requireActiveConnector(state.connectorId, "github");
                    if (state.teamId) {
                        await assertCanCreateTeamGraph(currentUser, state.teamId);
                    } else {
                        await assertCanCreateTopLevelGraph(currentUser);
                    }
                    const account = await getGitHubConnectorInstallationAccount(connector, query.installation_id);
                    const ownerOrganizationId = state.organizationId ?? currentUser.activeOrganizationId;
                    const conflictTarget = state.teamId
                        ? {
                              target: [
                                  connectorInstallationsTable.connectorId,
                                  connectorInstallationsTable.providerInstallationId,
                                  connectorInstallationsTable.organizationId,
                                  connectorInstallationsTable.teamId,
                              ],
                              targetWhere: sql`${connectorInstallationsTable.teamId} is not null`,
                          }
                        : {
                              target: [
                                  connectorInstallationsTable.connectorId,
                                  connectorInstallationsTable.providerInstallationId,
                                  connectorInstallationsTable.organizationId,
                              ],
                              targetWhere: sql`${connectorInstallationsTable.teamId} is null`,
                          };
                    const [installation] = await db
                        .insert(connectorInstallationsTable)
                        .values({
                            connectorId: connector.id,
                            provider: "github",
                            providerInstallationId: query.installation_id,
                            providerAccountLogin: account.login,
                            providerAccountType: account.type,
                            organizationId: ownerOrganizationId,
                            teamId: state.teamId ?? null,
                            installedByUserId: currentUser.id,
                            repositorySelection: account.repositorySelection,
                        })
                        .onConflictDoUpdate({
                            ...conflictTarget,
                            set: {
                                providerAccountLogin: account.login,
                                providerAccountType: account.type,
                                repositorySelection: account.repositorySelection,
                                status: "active",
                                installedByUserId: currentUser.id,
                            },
                        })
                        .returning();
                    return toPublicInstallation(installation);
                },
            }),
        { query: installCallbackQuerySchema }
    )
    .get("/:id/installations", async ({ params, status, user }) =>
        runConnectorAction({
            user,
            status,
            action: async (currentUser) => {
                await requireActiveConnector(params.id);
                const rows = await db
                    .select()
                    .from(connectorInstallationsTable)
                    .where(
                        and(
                            eq(connectorInstallationsTable.connectorId, params.id),
                            eq(connectorInstallationsTable.status, "active")
                        )
                    )
                    .orderBy(asc(connectorInstallationsTable.providerAccountLogin));
                const visible = [];
                for (const row of rows) {
                    const allowed = await Result.tryPromise(async () => assertCanUseInstallation(currentUser, row.id));
                    if (!allowed.isErr()) {
                        visible.push(toPublicInstallation(row));
                    }
                }
                return visible;
            },
        })
    )
    .get(
        "/:id/repositories",
        async ({ params, query, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    const installation = await assertCanUseInstallation(currentUser, query.installationId);
                    assertInstallationBelongsToConnector(installation, params.id);
                    const connector = await requireActiveConnector(
                        params.id,
                        installation.provider as ConnectorProvider
                    );
                    const repositories = await listProviderRepositories(connector, installation);
                    return repositories.map((repository) => ({
                        id: repository.id,
                        provider: repository.provider,
                        fullName: repository.fullName,
                        name: repository.name,
                        htmlUrl: repository.htmlUrl,
                        defaultBranch: repository.defaultBranch,
                        private: repository.private,
                    }));
                },
            }),
        { query: repositoryQuerySchema }
    )
    .get(
        "/:id/repositories/:repositoryId/branches",
        async ({ params, query, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    const installation = await assertCanUseInstallation(currentUser, query.installationId);
                    assertInstallationBelongsToConnector(installation, params.id);
                    const connector = await requireActiveConnector(
                        params.id,
                        installation.provider as ConnectorProvider
                    );
                    const branches = await listProviderBranches(connector, installation, params.repositoryId);
                    return branches.map((branch) => ({ name: branch.name, commitSha: branch.commitSha }));
                },
            }),
        { query: repositoryQuerySchema }
    )
    .post(
        "/:id/repository-graphs",
        async ({ params, body, status, user }) =>
            runConnectorAction({
                user,
                status,
                action: async (currentUser) => {
                    const installation = await assertCanUseInstallation(currentUser, body.connectorInstallationId);
                    assertInstallationBelongsToConnector(installation, params.id);
                    if (body.owner.kind === "team") {
                        if (installation.teamId !== body.owner.teamId) {
                            throw new Error(API_ERROR_CODES.FORBIDDEN);
                        }
                        await assertCanCreateTeamGraph(currentUser, body.owner.teamId);
                    } else {
                        if (installation.teamId !== null) {
                            throw new Error(API_ERROR_CODES.FORBIDDEN);
                        }
                        await assertCanCreateTopLevelGraph(currentUser);
                    }

                    const connector = await requireActiveConnector(
                        params.id,
                        installation.provider as ConnectorProvider
                    );
                    const repositories = await listProviderRepositories(connector, installation);
                    const repository = repositories.find((candidate) =>
                        repositoryMatches(candidate, body.repositoryId)
                    );
                    if (!repository) {
                        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
                    }

                    const branches = await listProviderBranches(connector, installation, repository.id);
                    const branch = branches.find((candidate) => candidate.name === body.branch);
                    if (!branch) {
                        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
                    }

                    const created = await db.transaction(async (tx) => {
                        const [graph] = await tx
                            .insert(graphTable)
                            .values({
                                organizationId: installation.organizationId,
                                teamId: body.owner.kind === "team" ? body.owner.teamId : null,
                                name: body.name,
                                description: null,
                                state: "updating",
                                type: "code",
                            })
                            .returning();

                        const [binding] = await tx
                            .insert(repositoryGraphBindingsTable)
                            .values({
                                graphId: graph.id,
                                connectorInstallationId: installation.id,
                                provider: connector.provider,
                                providerRepositoryId: repository.id,
                                repositoryFullName: repository.fullName,
                                repositoryHtmlUrl: repository.htmlUrl,
                                branch: branch.name,
                                lastSeenCommitSha: branch.commitSha,
                                syncStatus: "pending",
                            })
                            .returning();

                        return { graph, binding };
                    });

                    try {
                        const handle = await ow.runWorkflow(syncRepositoryGraphSpec, {
                            bindingId: created.binding.id,
                            reason: "initial",
                            commitSha: branch.commitSha,
                        });
                        return {
                            graph: created.graph,
                            binding: toBindingResponse(created.binding),
                            workflowRunId: handle.workflowRun.id,
                        };
                    } catch (error) {
                        await Promise.all([
                            db
                                .update(repositoryGraphBindingsTable)
                                .set({ syncStatus: "failed", syncErrorCode: "enqueue_failed" })
                                .where(eq(repositoryGraphBindingsTable.id, created.binding.id)),
                            db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, created.graph.id)),
                        ]);
                        throw error;
                    }
                },
            }),
        { body: createRepositoryGraphSchema }
    );

export const repositoryGraphBindingRoute = new Elysia({ prefix: "/repository-graph-bindings" })
    .use(authMiddleware)
    .get("/:id", async ({ params, status, user }) =>
        runConnectorAction({
            user,
            status,
            action: async (currentUser) => {
                const { binding } = await assertCanViewBinding(currentUser, params.id);
                return toBindingResponse(binding);
            },
        })
    )
    .post("/:id/sync", async ({ params, status, user }) =>
        runConnectorAction({
            user,
            status,
            action: async (currentUser) => {
                const { binding } = await assertCanSyncBinding(currentUser, params.id);
                const [updatedBinding] = await db
                    .update(repositoryGraphBindingsTable)
                    .set({ syncStatus: "pending", syncErrorCode: null })
                    .where(eq(repositoryGraphBindingsTable.id, binding.id))
                    .returning();
                try {
                    const handle = await ow.runWorkflow(syncRepositoryGraphSpec, {
                        bindingId: binding.id,
                        reason: "manual",
                    });
                    return {
                        binding: toBindingResponse(updatedBinding ?? binding),
                        workflowRunId: handle.workflowRun.id,
                    };
                } catch (error) {
                    await db
                        .update(repositoryGraphBindingsTable)
                        .set({ syncStatus: "failed", syncErrorCode: "enqueue_failed" })
                        .where(eq(repositoryGraphBindingsTable.id, binding.id));
                    throw error;
                }
            },
        })
    );
