import { createHash } from "node:crypto";
import {
    ConnectorProviderError,
    MAX_REPOSITORY_CODE_BYTES,
    MAX_REPOSITORY_CODE_FILES,
    createGitHubClient,
    createGitHubInstallationToken,
    createGitLabClient,
    decryptConnectorCredentials,
    normalizeGitLabBaseUrl,
} from "@kiwi/connectors";
import type {
    ConnectorSecretPayload,
    GitHubConnectorCredentials,
    GitLabConnectorCredentials,
    GitLabInstallationCredentials,
    ProviderCodeFile,
    ProviderRepository,
    ProviderRepositoryChange,
    ProviderRepositoryClient,
    ProviderRepositorySnapshot,
} from "@kiwi/connectors";
import { db } from "@kiwi/db";
import {
    connectorInstallationsTable,
    connectorsTable,
    connectorWebhookEventsTable,
    repositoryGraphBindingsTable,
} from "@kiwi/db/tables/connectors";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import { serializeCodeFileMetadata } from "@kiwi/graph/code/metadata";
import { and, eq, inArray } from "drizzle-orm";
import { defineWorkflow } from "openworkflow";
import { parseCodeFileMetadata } from "../lib/code-file-metadata";
import { env } from "../env";
import { deleteFileSpec } from "./delete-file-spec";
import { processFilesSpec } from "./process-files-spec";
import { syncRepositoryGraphSpec } from "./sync-repository-graph-spec";

type BindingGraphRow = {
    binding: typeof repositoryGraphBindingsTable.$inferSelect;
    installation: typeof connectorInstallationsTable.$inferSelect;
    connector: typeof connectorsTable.$inferSelect;
    graph: typeof graphTable.$inferSelect;
};

type ProviderClientContext = {
    client: ProviderRepositoryClient;
    gitLabBaseUrl?: string;
};

type Snapshot = ProviderRepositorySnapshot & {
    files: ProviderCodeFile[];
};

type ActiveBindingFile = {
    id: string;
    size: number;
    path: string;
};

type IncrementalSyncPlan = {
    newPaths: string[];
    retiredFileIds: string[];
};

type InsertedRepositoryFiles = {
    fileIds: string[];
    processRunId: string;
};

const NO_RETRY = { maximumAttempts: 1 } as const;

async function loadBindingGraph(bindingId: string): Promise<BindingGraphRow | null> {
    const [row] = await db
        .select({
            binding: repositoryGraphBindingsTable,
            installation: connectorInstallationsTable,
            connector: connectorsTable,
            graph: graphTable,
        })
        .from(repositoryGraphBindingsTable)
        .innerJoin(
            connectorInstallationsTable,
            eq(connectorInstallationsTable.id, repositoryGraphBindingsTable.connectorInstallationId)
        )
        .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
        .innerJoin(graphTable, eq(graphTable.id, repositoryGraphBindingsTable.graphId))
        .where(eq(repositoryGraphBindingsTable.id, bindingId))
        .limit(1);
    return row ?? null;
}

function isGitHubConnectorCredentials(value: ConnectorSecretPayload): value is GitHubConnectorCredentials {
    return "provider" in value && value.provider === "github";
}

function isGitLabConnectorCredentials(value: ConnectorSecretPayload): value is GitLabConnectorCredentials {
    return "provider" in value && value.provider === "gitlab" && "baseUrl" in value;
}

function isGitLabInstallationCredentials(value: ConnectorSecretPayload): value is GitLabInstallationCredentials {
    return "provider" in value && value.provider === "gitlab" && "accessToken" in value;
}

function repositoryFromBinding(row: BindingGraphRow): ProviderRepository {
    return {
        provider: row.connector.provider as ProviderRepository["provider"],
        id: row.binding.providerRepositoryId,
        fullName: row.binding.repositoryFullName,
        name: row.binding.repositoryFullName.split("/").at(-1) ?? row.binding.repositoryFullName,
        htmlUrl: row.binding.repositoryHtmlUrl,
        defaultBranch: row.binding.branch,
        private: true,
    };
}

async function createProviderClient(row: BindingGraphRow): Promise<ProviderClientContext> {
    const connectorCredentials = decryptConnectorCredentials(row.connector.encryptedCredentials, env.AUTH_SECRET);
    if (row.connector.provider === "github") {
        if (!isGitHubConnectorCredentials(connectorCredentials)) {
            throw new Error("Invalid connector credentials");
        }
        const token = await createGitHubInstallationToken({
            credentials: connectorCredentials,
            installationId: row.installation.providerInstallationId,
        });
        return {
            client: createGitHubClient({ installationToken: token.token }),
        };
    }

    if (!isGitLabConnectorCredentials(connectorCredentials)) {
        throw new Error("Invalid connector credentials");
    }
    const installationCredentials = row.installation.encryptedCredentials
        ? decryptConnectorCredentials(row.installation.encryptedCredentials, env.AUTH_SECRET)
        : null;
    if (!installationCredentials || !isGitLabInstallationCredentials(installationCredentials)) {
        throw new Error("Invalid connector installation credentials");
    }
    return {
        client: createGitLabClient({
            baseUrl: connectorCredentials.baseUrl,
            accessToken: installationCredentials.accessToken,
        }),
        gitLabBaseUrl: connectorCredentials.baseUrl,
    };
}

async function resolveTargetCommitSha(
    row: BindingGraphRow,
    client: ProviderRepositoryClient,
    inputCommitSha?: string
): Promise<string> {
    if (inputCommitSha) {
        return inputCommitSha;
    }

    const branch = (await client.listBranches(repositoryFromBinding(row))).find(
        (candidate) => candidate.name === row.binding.branch
    );
    if (!branch) {
        throw new ConnectorProviderError("not-found", "Repository branch was not found");
    }

    return branch.commitSha;
}

async function loadSnapshot(
    row: BindingGraphRow,
    client: ProviderRepositoryClient,
    commitSha: string
): Promise<Snapshot> {
    return client.loadRepositorySnapshot(
        repositoryFromBinding(row),
        row.binding.branch,
        commitSha
    ) as Promise<Snapshot>;
}

async function loadActiveBindingFiles(bindingId: string): Promise<Map<string, ActiveBindingFile>> {
    const rows = await db
        .select({
            id: filesTable.id,
            size: filesTable.size,
            metadata: filesTable.metadata,
        })
        .from(filesTable)
        .where(
            and(
                eq(filesTable.repositoryBindingId, bindingId),
                eq(filesTable.type, "code"),
                eq(filesTable.deleted, false)
            )
        );

    const filesByPath = new Map<string, ActiveBindingFile>();
    for (const row of rows) {
        const metadata = parseCodeFileMetadata(row.metadata);
        if (!metadata) {
            throw new Error(`Active binding file ${row.id} is missing repository metadata`);
        }
        if (filesByPath.has(metadata.path)) {
            throw new Error(`Repository binding ${bindingId} has multiple active rows for ${metadata.path}`);
        }
        filesByPath.set(metadata.path, {
            id: row.id,
            size: row.size,
            path: metadata.path,
        });
    }

    return filesByPath;
}

function planIncrementalChanges(
    activeFiles: Map<string, ActiveBindingFile>,
    changes: ProviderRepositoryChange[]
): IncrementalSyncPlan {
    const seenPaths = new Set<string>();
    const newPaths: string[] = [];
    const retiredFileIds = new Set<string>();

    const trackPath = (path: string) => {
        if (seenPaths.has(path)) {
            throw new Error(`Provider delta contained duplicate path ${path}`);
        }
        seenPaths.add(path);
    };

    const retirePath = (path: string) => {
        const activeFile = activeFiles.get(path);
        if (activeFile) {
            retiredFileIds.add(activeFile.id);
        }
    };

    for (const change of changes) {
        switch (change.status) {
            case "added":
            case "modified":
                trackPath(change.newPath);
                newPaths.push(change.newPath);
                retirePath(change.newPath);
                break;
            case "deleted":
                trackPath(change.oldPath);
                retirePath(change.oldPath);
                break;
            case "renamed":
                trackPath(change.oldPath);
                trackPath(change.newPath);
                retirePath(change.oldPath);
                retirePath(change.newPath);
                newPaths.push(change.newPath);
                break;
        }
    }

    return {
        newPaths,
        retiredFileIds: [...retiredFileIds],
    };
}

function buildConnectorFile(
    row: BindingGraphRow,
    context: ProviderClientContext,
    commitSha: string,
    path: string,
    content: string
): ProviderCodeFile {
    const rawUrl =
        row.connector.provider === "github"
            ? `https://raw.githubusercontent.com/${row.binding.repositoryFullName}/${commitSha}/${path}`
            : context.gitLabBaseUrl
              ? `${normalizeGitLabBaseUrl(context.gitLabBaseUrl)}/api/v4/projects/${encodeURIComponent(row.binding.providerRepositoryId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(commitSha)}`
              : undefined;

    return {
        path,
        size: Buffer.byteLength(content, "utf8"),
        checksum: createHash("sha256").update(content, "utf8").digest("hex"),
        htmlUrl:
            row.connector.provider === "github"
                ? `${row.binding.repositoryHtmlUrl}/blob/${commitSha}/${path}`
                : `${row.binding.repositoryHtmlUrl}/-/blob/${commitSha}/${path}`,
        ...(rawUrl ? { rawUrl } : {}),
        content,
    };
}

function assertBindingSnapshotLimits(
    activeFiles: Map<string, ActiveBindingFile>,
    retiredFileIds: string[],
    newFiles: ProviderCodeFile[]
) {
    const retiredIds = new Set(retiredFileIds);
    const totalFileCount =
        [...activeFiles.values()].filter((file) => !retiredIds.has(file.id)).length + newFiles.length;
    if (totalFileCount > MAX_REPOSITORY_CODE_FILES) {
        throw new ConnectorProviderError("limit", "Repository contains too many supported code files");
    }

    const totalBytes =
        [...activeFiles.values()].reduce((sum, file) => sum + (retiredIds.has(file.id) ? 0 : file.size), 0) +
        newFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_REPOSITORY_CODE_BYTES) {
        throw new ConnectorProviderError("limit", "Repository contains too much supported code");
    }
}

function fileRows(row: BindingGraphRow, files: ProviderCodeFile[], commitSha: string) {
    return files.map((file) => ({
        graphId: row.binding.graphId,
        name: file.path,
        size: file.size,
        type: "code",
        mimeType: "text/plain",
        key: `connector:${row.binding.id}:${commitSha}:${file.path}`,
        storageKind: "external",
        externalUrl: file.rawUrl ?? file.htmlUrl,
        externalProvider: row.connector.provider,
        repositoryBindingId: row.binding.id,
        checksum: `${commitSha}:${file.path}:${file.checksum}`,
        metadata: serializeCodeFileMetadata({
            repositoryUrl: row.binding.repositoryHtmlUrl,
            repositoryName: row.binding.repositoryFullName,
            commitSha,
            path: file.path,
            external:
                row.connector.provider === "github" && file.rawUrl
                    ? { provider: "github", rawUrl: file.rawUrl, htmlUrl: file.htmlUrl }
                    : undefined,
        }),
        id: crypto.randomUUID(),
    }));
}

type InsertedFileRow = {
    id: string;
    key: string;
};

function orderedFilesByKey(rows: ReturnType<typeof fileRows>, files: InsertedFileRow[]): InsertedFileRow[] {
    const filesByKey = new Map(files.map((file) => [file.key, file]));
    const orderedFiles: InsertedFileRow[] = [];
    for (const row of rows) {
        const file = filesByKey.get(row.key);
        if (file) {
            orderedFiles.push(file);
        }
    }
    return orderedFiles;
}

async function insertRepositoryFiles(
    row: BindingGraphRow,
    files: ProviderCodeFile[],
    commitSha: string
): Promise<InsertedRepositoryFiles> {
    return db.transaction(async (tx) => {
        await tx
            .update(repositoryGraphBindingsTable)
            .set({ syncStatus: "syncing", lastSeenCommitSha: commitSha, syncErrorCode: null })
            .where(eq(repositoryGraphBindingsTable.id, row.binding.id));

        const rows = fileRows(row, files, commitSha);
        const insertedFiles = await tx
            .insert(filesTable)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: filesTable.id, key: filesTable.key });
        let committedFiles = orderedFilesByKey(rows, insertedFiles);
        if (committedFiles.length !== files.length) {
            const existingFiles = await tx
                .select({ id: filesTable.id, key: filesTable.key })
                .from(filesTable)
                .where(
                    and(
                        eq(filesTable.graphId, row.binding.graphId),
                        eq(filesTable.deleted, false),
                        inArray(
                            filesTable.key,
                            rows.map((file) => file.key)
                        )
                    )
                );
            committedFiles = orderedFilesByKey(rows, existingFiles);
        }
        if (committedFiles.length !== files.length) {
            throw new Error("Failed to insert all repository files");
        }

        let processRunId: string | null = null;
        if (insertedFiles.length === 0) {
            const existingProcessRuns = await tx
                .select({ id: processRunFilesTable.processRunId })
                .from(processRunFilesTable)
                .innerJoin(processRunsTable, eq(processRunFilesTable.processRunId, processRunsTable.id))
                .where(
                    and(
                        eq(processRunsTable.graphId, row.binding.graphId),
                        inArray(
                            processRunFilesTable.fileId,
                            committedFiles.map((file) => file.id)
                        )
                    )
                );
            processRunId = existingProcessRuns[0]?.id ?? null;
        }

        if (!processRunId) {
            const [processRun] = await tx
                .insert(processRunsTable)
                .values({ graphId: row.binding.graphId, status: "pending" })
                .returning({ id: processRunsTable.id });
            if (!processRun) {
                throw new Error("Failed to create process run");
            }
            const newProcessRunId = processRun.id;
            processRunId = newProcessRunId;

            await tx.insert(processRunFilesTable).values(
                committedFiles.map((file) => ({
                    processRunId: newProcessRunId,
                    fileId: file.id,
                }))
            );
        }

        return {
            fileIds: committedFiles.map((file) => file.id),
            processRunId,
        };
    });
}

async function markWebhookDuplicate(provider: typeof connectorsTable.$inferSelect.provider, deliveryId: string) {
    await db
        .update(connectorWebhookEventsTable)
        .set({ status: "duplicate" })
        .where(
            and(
                eq(connectorWebhookEventsTable.provider, provider),
                eq(connectorWebhookEventsTable.deliveryId, deliveryId)
            )
        );
}

async function markBindingSynced(bindingId: string, commitSha: string) {
    await db
        .update(repositoryGraphBindingsTable)
        .set({
            syncStatus: "synced",
            lastSeenCommitSha: commitSha,
            lastSyncedCommitSha: commitSha,
            syncErrorCode: null,
        })
        .where(eq(repositoryGraphBindingsTable.id, bindingId));
}

async function markBindingFailed(bindingId: string) {
    await db
        .update(repositoryGraphBindingsTable)
        .set({ syncStatus: "failed", syncErrorCode: "sync_failed" })
        .where(eq(repositoryGraphBindingsTable.id, bindingId));
}

export const syncRepositoryGraph = defineWorkflow(syncRepositoryGraphSpec, async ({ input, step, run }) => {
    try {
        const row = await step.run({ name: "load-binding" }, async () => loadBindingGraph(input.bindingId));
        if (
            !row ||
            row.connector.status !== "active" ||
            row.installation.status !== "active" ||
            !row.binding.webhookEnabled
        ) {
            return { skipped: true };
        }

        const context = await step.run({ name: "create-provider-client" }, async () => createProviderClient(row));
        const commitSha = await step.run({ name: "resolve-target-commit" }, async () =>
            resolveTargetCommitSha(row, context.client, input.commitSha)
        );

        if (row.binding.lastSyncedCommitSha === commitSha) {
            if (input.deliveryId) {
                await step.run({ name: "mark-webhook-duplicate" }, async () =>
                    markWebhookDuplicate(row.connector.provider, input.deliveryId!)
                );
            }
            return { skipped: true, commitSha };
        }

        if (!row.binding.lastSyncedCommitSha) {
            const snapshot = await step.run({ name: "load-provider-snapshot" }, async () =>
                loadSnapshot(row, context.client, commitSha)
            );
            if (snapshot.files.length === 0) {
                await step.run({ name: "mark-empty-binding-synced" }, async () =>
                    markBindingSynced(row.binding.id, commitSha)
                );
                return { commitSha, fileCount: 0 };
            }

            const created = await step.run({ name: "commit-external-files" }, async () =>
                insertRepositoryFiles(row, snapshot.files, commitSha)
            );
            try {
                await step.runWorkflow(processFilesSpec, {
                    graphId: row.binding.graphId,
                    fileIds: created.fileIds,
                    processRunId: created.processRunId,
                    code: { kind: "repository", retiredFileIds: [] },
                });
            } catch (error) {
                await Promise.all(
                    created.fileIds.map((fileId) =>
                        step.runWorkflow(deleteFileSpec, {
                            graphId: row.binding.graphId,
                            fileId,
                        })
                    )
                );
                throw error;
            }

            await step.run({ name: "mark-binding-synced" }, async () => markBindingSynced(row.binding.id, commitSha));
            return { commitSha, fileCount: created.fileIds.length };
        }

        const activeFiles = await step.run({ name: "load-active-binding-files" }, async () =>
            loadActiveBindingFiles(row.binding.id)
        );
        const delta = await step.run({ name: "compare-provider-commits" }, async () =>
            context.client.compareRepository(repositoryFromBinding(row), row.binding.lastSyncedCommitSha!, commitSha)
        );
        if (!delta.isIncremental) {
            const snapshot = await step.run({ name: "load-provider-snapshot" }, async () =>
                loadSnapshot(row, context.client, commitSha)
            );
            const retiredFileIds = [...activeFiles.values()].map((file) => file.id);
            assertBindingSnapshotLimits(activeFiles, retiredFileIds, snapshot.files);

            if (snapshot.files.length > 0) {
                const created = await step.run({ name: "commit-external-files" }, async () =>
                    insertRepositoryFiles(row, snapshot.files, commitSha)
                );
                try {
                    await step.runWorkflow(processFilesSpec, {
                        graphId: row.binding.graphId,
                        fileIds: created.fileIds,
                        processRunId: created.processRunId,
                        code: { kind: "repository", retiredFileIds },
                    });
                } catch (error) {
                    await Promise.all(
                        created.fileIds.map((fileId) =>
                            step.runWorkflow(deleteFileSpec, {
                                graphId: row.binding.graphId,
                                fileId,
                            })
                        )
                    );
                    throw error;
                }

                await step.run({ name: "mark-binding-synced" }, async () =>
                    markBindingSynced(row.binding.id, commitSha)
                );
                return { commitSha, fileCount: created.fileIds.length };
            }

            if (retiredFileIds.length > 0) {
                await step.runWorkflow(processFilesSpec, {
                    graphId: row.binding.graphId,
                    fileIds: [],
                    code: { kind: "repository", retiredFileIds },
                });
            }
            await step.run({ name: "mark-binding-synced" }, async () => markBindingSynced(row.binding.id, commitSha));
            return { commitSha, fileCount: 0 };
        }
        const plan = planIncrementalChanges(activeFiles, delta.changes);
        if (plan.newPaths.length === 0 && plan.retiredFileIds.length === 0) {
            await step.run({ name: "mark-binding-synced" }, async () => markBindingSynced(row.binding.id, commitSha));
            return { commitSha, fileCount: 0 };
        }

        const changedFiles =
            plan.newPaths.length > 0
                ? await step.run({ name: "load-changed-files" }, async () =>
                      Promise.all(
                          plan.newPaths.map(async (path) =>
                              buildConnectorFile(
                                  row,
                                  context,
                                  commitSha,
                                  path,
                                  await context.client.readFile(repositoryFromBinding(row), path, commitSha)
                              )
                          )
                      )
                  )
                : [];
        assertBindingSnapshotLimits(activeFiles, plan.retiredFileIds, changedFiles);

        if (changedFiles.length > 0) {
            const created = await step.run({ name: "commit-external-files" }, async () =>
                insertRepositoryFiles(row, changedFiles, commitSha)
            );
            try {
                await step.runWorkflow(processFilesSpec, {
                    graphId: row.binding.graphId,
                    fileIds: created.fileIds,
                    processRunId: created.processRunId,
                    code: { kind: "repository", retiredFileIds: plan.retiredFileIds },
                });
            } catch (error) {
                await Promise.all(
                    created.fileIds.map((fileId) =>
                        step.runWorkflow(deleteFileSpec, {
                            graphId: row.binding.graphId,
                            fileId,
                        })
                    )
                );
                throw error;
            }
            await step.run({ name: "mark-binding-synced" }, async () => markBindingSynced(row.binding.id, commitSha));
            return { commitSha, fileCount: created.fileIds.length };
        }

        await step.runWorkflow(processFilesSpec, {
            graphId: row.binding.graphId,
            fileIds: [],
            code: { kind: "repository", retiredFileIds: plan.retiredFileIds },
        });
        await step.run({ name: "mark-binding-synced" }, async () => markBindingSynced(row.binding.id, commitSha));
        return { commitSha, fileCount: 0 };
    } catch (error) {
        if (run.retryTerminal) {
            await step.run({ name: "mark-binding-failed", retryPolicy: NO_RETRY }, async () =>
                markBindingFailed(input.bindingId)
            );
        }

        throw error;
    }
});
