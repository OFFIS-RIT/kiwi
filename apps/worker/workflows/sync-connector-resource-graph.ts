import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import {
    ConnectorProviderError,
    MAX_REPOSITORY_CODE_BYTES as MAX_CONNECTOR_CODE_BYTES,
    MAX_REPOSITORY_CODE_FILES as MAX_CONNECTOR_CODE_FILES,
    createConnectorAdapter,
    normalizeGitLabBaseUrl,
} from "@kiwi/connectors";
import type {
    ConnectorAdapter,
    ConnectorCredentials,
    ConnectorInstallationCredentials,
    ConnectorProvider,
    ConnectorResourceChange,
    ConnectorResourceSnapshot,
    ConnectorResourceKind,
    GitLabConnectorCredentials,
    ProviderCodeFile,
} from "@kiwi/connectors";
import { decryptConnectorCredentials } from "@kiwi/connectors/credentials";
import type { ConnectorSecretPayload } from "@kiwi/connectors/credentials";
import { db } from "@kiwi/db";
import {
    connectorInstallationsTable,
    connectorsTable,
    connectorResourceBindingsTable,
    connectorWebhookEventsTable,
} from "@kiwi/db/tables/connectors";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import type { ProcessRunStatus } from "@kiwi/db/tables/graph";
import { serializeCodeFileMetadata } from "@kiwi/graph/code/metadata";
import { and, eq, inArray } from "drizzle-orm";
import { defineWorkflow } from "openworkflow";
import type { Workflow } from "openworkflow";
import { parseCodeFileMetadata } from "../lib/code-file-metadata";
import { env } from "../env";
import { deleteFileSpec } from "./delete-file-spec";
import { processFilesSpec } from "./process-files-spec";
import { syncConnectorResourceGraphSpec } from "./sync-connector-resource-graph-spec";

type BindingGraphRow = {
    binding: typeof connectorResourceBindingsTable.$inferSelect;
    installation: typeof connectorInstallationsTable.$inferSelect;
    connector: typeof connectorsTable.$inferSelect;
    graph: typeof graphTable.$inferSelect;
};

type ConnectorAdapterContext = {
    adapter: ConnectorAdapter;
    gitLabBaseUrl?: string;
};

type ConnectorSyncFile = ProviderCodeFile & {
    displayName?: string;
    providerFileId?: string;
    versionId?: string;
    etag?: string;
    webUrl?: string;
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

type ReusableProcessRunStatus = Exclude<ProcessRunStatus, "failed">;

type InsertedConnectorFiles = {
    fileIds: string[];
    processRunId: string;
    processRunStatus: ReusableProcessRunStatus;
};

type InsertedFileRow = {
    id: string;
    key: string;
};

type ConnectorFileRow = {
    graphId: string;
    name: string;
    size: number;
    type: "code";
    mimeType: "text/plain";
    key: string;
    storageKind: "external";
    externalUrl: string;
    externalProvider: string;
    connectorBindingId: string;
    checksum: string;
    metadata: string;
    id: string;
};
type WorkflowStep = Pick<Parameters<Workflow<unknown, unknown, unknown>["fn"]>[0]["step"], "runWorkflow">;

type CompatibleCodeFileMetadata = {
    path: string;
    versionId?: string;
    git?: { commitSha?: string };
};

type ConnectorFileMetadataInput = {
    schemaVersion: 2;
    provider: ConnectorProvider;
    bindingId: string;
    resourceKind: ConnectorResourceKind;
    providerResourceId: string;
    resourceDisplayName: string;
    path: string;
    displayName: string;
    versionId?: string;
    providerFileId?: string;
    etag?: string;
    webUrl?: string;
    rawUrl?: string;
    git?: {
        repositoryName: string;
        repositoryUrl?: string;
        commitSha: string;
        branch?: string;
    };
};

const NO_RETRY = { maximumAttempts: 1 } as const;
const PROVIDER_FILE_READ_CONCURRENCY = 4;

function loadBindingGraph(bindingId: string): Effect.Effect<BindingGraphRow | null, unknown> {
    return Effect.map(
        Effect.tryPromise(() =>
            Promise.resolve(
                db
                    .select({
                        binding: connectorResourceBindingsTable,
                        installation: connectorInstallationsTable,
                        connector: connectorsTable,
                        graph: graphTable,
                    })
                    .from(connectorResourceBindingsTable)
                    .innerJoin(
                        connectorInstallationsTable,
                        eq(connectorInstallationsTable.id, connectorResourceBindingsTable.connectorInstallationId)
                    )
                    .innerJoin(connectorsTable, eq(connectorsTable.id, connectorInstallationsTable.connectorId))
                    .innerJoin(graphTable, eq(graphTable.id, connectorResourceBindingsTable.graphId))
                    .where(eq(connectorResourceBindingsTable.id, bindingId))
                    .limit(1)
            )
        ),
        ([row]) => row ?? null
    );
}

function isConnectorProvider(value: string): value is ConnectorProvider {
    return value === "github" || value === "gitlab";
}

function isConnectorCredentials(value: ConnectorSecretPayload, provider: ConnectorProvider): value is ConnectorCredentials {
    return "provider" in value && value.provider === provider && (provider === "github" ? "appId" in value : "baseUrl" in value);
}

function isGitLabConnectorCredentials(value: ConnectorCredentials): value is GitLabConnectorCredentials {
    return value.provider === "gitlab";
}

function isInstallationCredentials(
    value: ConnectorSecretPayload,
    provider: ConnectorProvider
): value is ConnectorInstallationCredentials {
    return (
        "provider" in value &&
        value.provider === provider &&
        (provider === "github" ? "installationId" in value : "accessToken" in value)
    );
}

function connectorProvider(row: BindingGraphRow): ConnectorProvider {
    if (!isConnectorProvider(row.connector.provider)) {
        throw new Error("Unsupported connector provider");
    }
    return row.connector.provider;
}

function connectorResourceKind(row: BindingGraphRow): ConnectorResourceKind {
    if (row.binding.resourceKind !== "git-repository" && row.binding.resourceKind !== "folder") {
        throw new Error("Unsupported connector resource kind");
    }
    return row.binding.resourceKind;
}

function createAdapterContext(row: BindingGraphRow): Effect.Effect<ConnectorAdapterContext, unknown> {
    return Effect.gen(function* () {
        const provider = connectorProvider(row);
        const connectorCredentials = decryptConnectorCredentials(row.connector.encryptedCredentials, env.AUTH_SECRET);
        if (!isConnectorCredentials(connectorCredentials, provider)) {
            return yield* Effect.fail(new Error("Invalid connector credentials"));
        }

        const installationCredentials: ConnectorInstallationCredentials =
            provider === "github"
                ? { provider: "github", installationId: row.installation.providerInstallationId }
                : readStoredInstallationCredentials(row, provider);

        const adapter = yield* Effect.flatten(
            Effect.sync(() =>
                createConnectorAdapter({
                    provider,
                    credentials: connectorCredentials,
                    installation: installationCredentials,
                })
            )
        );
        return {
            adapter,
            ...(isGitLabConnectorCredentials(connectorCredentials)
                ? { gitLabBaseUrl: normalizeGitLabBaseUrl(connectorCredentials.baseUrl) }
                : {}),
        };
    });
}

function readStoredInstallationCredentials(row: BindingGraphRow, provider: ConnectorProvider): ConnectorInstallationCredentials {
    if (!row.installation.encryptedCredentials) {
        throw new Error("Invalid connector installation credentials");
    }
    const installationCredentials = decryptConnectorCredentials(row.installation.encryptedCredentials, env.AUTH_SECRET);
    if (!isInstallationCredentials(installationCredentials, provider)) {
        throw new Error("Invalid connector installation credentials");
    }
    return installationCredentials;
}

function resolveTargetVersion(row: BindingGraphRow, inputVersionId?: string): Effect.Effect<string, unknown> {
    if (inputVersionId) {
        return Effect.succeed(inputVersionId);
    }

    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        const version = (yield* adapter.listResourceVersions(row.binding.providerResourceId)).find(
            (candidate) => candidate.name === row.binding.versionName
        );
        if (!version) {
            return yield* Effect.fail(new ConnectorProviderError("not-found", "Connector resource version was not found"));
        }

        return version.versionId;
    });
}

function loadSnapshot(
    row: BindingGraphRow,
    versionId: string
): Effect.Effect<ConnectorResourceSnapshot, unknown> {
    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        return yield* adapter.loadSnapshot(row.binding.providerResourceId, row.binding.versionName, versionId);
    });
}

function compareResourceVersions(row: BindingGraphRow, fromVersionId: string, toVersionId: string) {
    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        return yield* adapter.compareVersions(row.binding.providerResourceId, fromVersionId, toVersionId);
    });
}

function loadChangedFiles(
    row: BindingGraphRow,
    versionId: string,
    paths: string[]
): Effect.Effect<ConnectorSyncFile[], unknown> {
    return Effect.gen(function* () {
        const context = yield* createAdapterContext(row);
        const files: ConnectorSyncFile[] = [];
        for (let index = 0; index < paths.length; index += PROVIDER_FILE_READ_CONCURRENCY) {
            const batch = paths.slice(index, index + PROVIDER_FILE_READ_CONCURRENCY);
            files.push(
                ...(yield* Effect.all(
                    batch.map((path) =>
                        Effect.map(
                            context.adapter.readFile({ resourceId: row.binding.providerResourceId, path, versionId }),
                            (content) => buildConnectorFile(row, context, versionId, path, content)
                        )
                    ),
                    { concurrency: PROVIDER_FILE_READ_CONCURRENCY }
                ))
            );
        }
        return files;
    });
}

function loadActiveBindingFiles(bindingId: string): Effect.Effect<ActiveBindingFile[], unknown> {
    return Effect.tryPromise({
        try: async () => {
            const rows = await db
                .select({
                    id: filesTable.id,
                    size: filesTable.size,
                    metadata: filesTable.metadata,
                })
                .from(filesTable)
                .where(
                    and(eq(filesTable.connectorBindingId, bindingId), eq(filesTable.type, "code"), eq(filesTable.deleted, false))
                );

            const filesByPath = new Map<string, ActiveBindingFile>();
            for (const row of rows) {
                const metadata = parseCodeFileMetadata(row.metadata) as CompatibleCodeFileMetadata | null;
                if (!metadata) {
                    throw new Error(`Active connector file ${row.id} is missing connector metadata`);
                }
                if (filesByPath.has(metadata.path)) {
                    throw new Error(`Connector binding ${bindingId} has multiple active rows for ${metadata.path}`);
                }
                filesByPath.set(metadata.path, {
                    id: row.id,
                    size: row.size,
                    path: metadata.path,
                });
            }

            return [...filesByPath.values()];
        },
        catch: (error) => error,
    });
}

function activeFilesByPath(files: ActiveBindingFile[]): Map<string, ActiveBindingFile> {
    return new Map(files.map((file) => [file.path, file]));
}

function planIncrementalChanges(
    activeFiles: Map<string, ActiveBindingFile>,
    changes: ConnectorResourceChange[]
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
    context: ConnectorAdapterContext,
    versionId: string,
    path: string,
    content: string
): ConnectorSyncFile {
    const urls = gitFileUrls(row, context, versionId, path);
    return {
        path,
        size: Buffer.byteLength(content, "utf8"),
        checksum: createHash("sha256").update(content, "utf8").digest("hex"),
        htmlUrl: urls.webUrl,
        ...(urls.rawUrl ? { rawUrl: urls.rawUrl } : {}),
        content,
        versionId,
    };
}

function gitFileUrls(
    row: BindingGraphRow,
    context: ConnectorAdapterContext,
    versionId: string,
    path: string
): { webUrl: string; rawUrl?: string } {
    if (row.binding.resourceKind !== "git-repository") {
        return { webUrl: row.binding.resourceWebUrl };
    }

    if (row.connector.provider === "github") {
        return {
            webUrl: `${row.binding.resourceWebUrl}/blob/${versionId}/${path}`,
            rawUrl: `https://raw.githubusercontent.com/${row.binding.resourceDisplayName}/${versionId}/${path}`,
        };
    }

    return {
        webUrl: `${row.binding.resourceWebUrl}/-/blob/${versionId}/${path}`,
        ...(context.gitLabBaseUrl
            ? {
                  rawUrl: `${context.gitLabBaseUrl}/api/v4/projects/${encodeURIComponent(row.binding.providerResourceId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(versionId)}`,
              }
            : {}),
    };
}

function assertBindingSnapshotLimits(
    activeFiles: Map<string, ActiveBindingFile>,
    retiredFileIds: string[],
    newFiles: ConnectorSyncFile[]
) {
    const retiredIds = new Set(retiredFileIds);
    const totalFileCount =
        [...activeFiles.values()].filter((file) => !retiredIds.has(file.id)).length + newFiles.length;
    if (totalFileCount > MAX_CONNECTOR_CODE_FILES) {
        throw new ConnectorProviderError("limit", "Connector resource contains too many supported code files");
    }

    const totalBytes =
        [...activeFiles.values()].reduce((sum, file) => sum + (retiredIds.has(file.id) ? 0 : file.size), 0) +
        newFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_CONNECTOR_CODE_BYTES) {
        throw new ConnectorProviderError("limit", "Connector resource contains too much supported code");
    }
}

function connectorFileKey(bindingId: string, file: ConnectorSyncFile, versionId: string): string {
    const fileVersionId = file.versionId ?? versionId;
    return file.providerFileId
        ? `connector:${bindingId}:${file.providerFileId}:${fileVersionId}`
        : `connector:${bindingId}:${fileVersionId}:${file.path}`;
}

function connectorFileMetadata(row: BindingGraphRow, file: ConnectorSyncFile, versionId: string): ConnectorFileMetadataInput {
    const fileVersionId = file.versionId ?? versionId;
    const webUrl = file.webUrl ?? file.htmlUrl;
    return {
        schemaVersion: 2,
        provider: connectorProvider(row),
        bindingId: row.binding.id,
        resourceKind: connectorResourceKind(row),
        providerResourceId: row.binding.providerResourceId,
        resourceDisplayName: row.binding.resourceDisplayName,
        path: file.path,
        displayName: file.displayName ?? file.path.split("/").at(-1) ?? file.path,
        ...(fileVersionId ? { versionId: fileVersionId } : {}),
        ...(file.providerFileId ? { providerFileId: file.providerFileId } : {}),
        ...(file.etag ? { etag: file.etag } : {}),
        ...(webUrl ? { webUrl } : {}),
        ...(file.rawUrl ? { rawUrl: file.rawUrl } : {}),
        ...(row.binding.resourceKind === "git-repository" && fileVersionId
            ? {
                  git: {
                      repositoryName: row.binding.resourceDisplayName,
                      repositoryUrl: row.binding.resourceWebUrl,
                      commitSha: fileVersionId,
                      branch: row.binding.versionName,
                  },
              }
            : {}),
    };
}

function fileRows(row: BindingGraphRow, files: ConnectorSyncFile[], versionId: string): ConnectorFileRow[] {
    return files.map((file) => {
        const key = connectorFileKey(row.binding.id, file, versionId);
        const fileVersionId = file.versionId ?? versionId;
        return {
            graphId: row.binding.graphId,
            name: file.path,
            size: file.size,
            type: "code",
            mimeType: "text/plain",
            key,
            storageKind: "external",
            externalUrl: file.rawUrl ?? file.webUrl ?? file.htmlUrl,
            externalProvider: row.connector.provider,
            connectorBindingId: row.binding.id,
            checksum: `${fileVersionId}:${file.providerFileId ?? file.path}:${file.checksum}`,
            metadata: serializeCodeFileMetadata(connectorFileMetadata(row, file, versionId)),
            id: crypto.randomUUID(),
        };
    });
}

function orderedFilesByKey(rows: ConnectorFileRow[], files: InsertedFileRow[]): InsertedFileRow[] {
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

type ReusableProcessRun = {
    id: string;
    status: ReusableProcessRunStatus;
};

function isReusableProcessRunStatus(status: ProcessRunStatus): status is ReusableProcessRunStatus {
    return status !== "failed";
}

function processRunStatusPriority(status: ReusableProcessRunStatus) {
    switch (status) {
        case "completed":
            return 0;
        case "started":
            return 1;
        case "pending":
            return 2;
    }
}

function findReusableProcessRun(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    graphId: string,
    fileIds: string[]
): Effect.Effect<ReusableProcessRun | null, unknown> {
    return Effect.tryPromise({
        try: async () => {
            if (fileIds.length === 0) {
                return null;
            }

            const matchingRunRows = await tx
                .select({
                    id: processRunFilesTable.processRunId,
                    status: processRunsTable.status,
                    fileId: processRunFilesTable.fileId,
                })
                .from(processRunFilesTable)
                .innerJoin(processRunsTable, eq(processRunFilesTable.processRunId, processRunsTable.id))
                .where(
                    and(
                        eq(processRunsTable.graphId, graphId),
                        inArray(processRunsTable.status, ["pending", "started", "completed"]),
                        inArray(processRunFilesTable.fileId, fileIds)
                    )
                );

            const expectedFileIds = new Set(fileIds);
            const candidates = new Map<string, ReusableProcessRun & { matchedFileIds: Set<string> }>();
            for (const row of matchingRunRows) {
                if (!isReusableProcessRunStatus(row.status)) {
                    continue;
                }
                const candidate = candidates.get(row.id);
                if (candidate) {
                    candidate.matchedFileIds.add(row.fileId);
                } else {
                    candidates.set(row.id, {
                        id: row.id,
                        status: row.status,
                        matchedFileIds: new Set([row.fileId]),
                    });
                }
            }

            const completeCandidateIds = [...candidates.values()]
                .filter((candidate) => candidate.matchedFileIds.size === expectedFileIds.size)
                .map((candidate) => candidate.id);
            if (completeCandidateIds.length === 0) {
                return null;
            }

            const runFileRows = await tx
                .select({ processRunId: processRunFilesTable.processRunId, fileId: processRunFilesTable.fileId })
                .from(processRunFilesTable)
                .where(inArray(processRunFilesTable.processRunId, completeCandidateIds));
            const fileIdsByRun = new Map<string, Set<string>>();
            for (const row of runFileRows) {
                const runFileIds = fileIdsByRun.get(row.processRunId);
                if (runFileIds) {
                    runFileIds.add(row.fileId);
                } else {
                    fileIdsByRun.set(row.processRunId, new Set([row.fileId]));
                }
            }

            const exactCandidates: ReusableProcessRun[] = [];
            for (const candidateId of completeCandidateIds) {
                const runFileIds = fileIdsByRun.get(candidateId);
                if (!runFileIds || runFileIds.size !== expectedFileIds.size) {
                    continue;
                }
                let exact = true;
                for (const fileId of runFileIds) {
                    if (!expectedFileIds.has(fileId)) {
                        exact = false;
                        break;
                    }
                }
                if (exact) {
                    const candidate = candidates.get(candidateId);
                    if (candidate) {
                        exactCandidates.push({ id: candidate.id, status: candidate.status });
                    }
                }
            }

            exactCandidates.sort((left, right) => processRunStatusPriority(left.status) - processRunStatusPriority(right.status));
            return exactCandidates[0] ?? null;
        },
        catch: (error) => error,
    });
}

function insertConnectorFiles(
    row: BindingGraphRow,
    files: ConnectorSyncFile[],
    versionId: string,
    cursor?: string
): Effect.Effect<InsertedConnectorFiles, unknown> {
    return Effect.tryPromise(() =>
        db.transaction(async (tx) => {
            await tx
                .update(connectorResourceBindingsTable)
                .set({
                    syncStatus: "syncing",
                    lastSeenVersionId: versionId,
                    syncErrorCode: null,
                    ...(cursor !== undefined ? { syncCursor: cursor } : {}),
                })
                .where(eq(connectorResourceBindingsTable.id, row.binding.id));

            const rows = fileRows(row, files, versionId);
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
                throw new Error("Failed to insert all connector files");
            }

            const fileIds = committedFiles.map((file) => file.id);
            if (insertedFiles.length === 0) {
                const reusableProcessRun = await Effect.runPromise(findReusableProcessRun(tx, row.binding.graphId, fileIds));
                if (reusableProcessRun) {
                    return {
                        fileIds,
                        processRunId: reusableProcessRun.id,
                        processRunStatus: reusableProcessRun.status,
                    };
                }
            }

            const [processRun] = await tx
                .insert(processRunsTable)
                .values({ graphId: row.binding.graphId, status: "pending" })
                .returning({ id: processRunsTable.id });
            if (!processRun) {
                throw new Error("Failed to create process run");
            }

            await tx.insert(processRunFilesTable).values(
                fileIds.map((fileId) => ({
                    processRunId: processRun.id,
                    fileId,
                }))
            );

            return {
                fileIds,
                processRunId: processRun.id,
                processRunStatus: "pending",
            };
        })
    );
}

function markWebhookDuplicate(provider: typeof connectorsTable.$inferSelect.provider, deliveryId: string) {
    return Effect.asVoid(
        Effect.tryPromise(() =>
            Promise.resolve(
                db
                    .update(connectorWebhookEventsTable)
                    .set({ status: "duplicate" })
                    .where(
                        and(
                            eq(connectorWebhookEventsTable.provider, provider),
                            eq(connectorWebhookEventsTable.deliveryId, deliveryId)
                        )
                    )
            )
        )
    );
}

function markBindingSynced(bindingId: string, versionId: string, cursor?: string) {
    return Effect.asVoid(
        Effect.tryPromise(() =>
            Promise.resolve(
                db
                    .update(connectorResourceBindingsTable)
                    .set({
                        syncStatus: "synced",
                        lastSeenVersionId: versionId,
                        lastSyncedVersionId: versionId,
                        syncErrorCode: null,
                        ...(cursor !== undefined ? { syncCursor: cursor } : {}),
                    })
                    .where(eq(connectorResourceBindingsTable.id, bindingId))
            )
        )
    );
}

function markBindingFailed(bindingId: string) {
    return Effect.asVoid(
        Effect.tryPromise(() =>
            Promise.resolve(
                db
                    .update(connectorResourceBindingsTable)
                    .set({ syncStatus: "failed", syncErrorCode: "sync_failed" })
                    .where(eq(connectorResourceBindingsTable.id, bindingId))
            )
        )
    );
}

function runProcessFilesWithCleanup(
    step: WorkflowStep,
    graphId: string,
    created: InsertedConnectorFiles,
    retiredFileIds: string[]
) {
    return Effect.tryPromise({
        try: async () => {
            if (created.processRunStatus === "completed") {
                return;
            }

            try {
                await step.runWorkflow(processFilesSpec, {
                    graphId,
                    fileIds: created.fileIds,
                    processRunId: created.processRunId,
                    code: { kind: "repository", retiredFileIds },
                });
            } catch (error) {
                await Promise.all(
                    created.fileIds.map((fileId) =>
                        step.runWorkflow(deleteFileSpec, {
                            graphId,
                            fileId,
                        })
                    )
                );
                throw error;
            }
        },
        catch: (error) => error,
    });
}

export const syncConnectorResourceGraph = defineWorkflow(syncConnectorResourceGraphSpec, async ({ input, step, run }) => {
    try {
        const row = await step.run({ name: "load-binding" }, async () => Effect.runPromise(loadBindingGraph(input.bindingId)));
        if (
            !row ||
            row.connector.status !== "active" ||
            row.installation.status !== "active" ||
            !row.binding.webhookEnabled
        ) {
            return { skipped: true };
        }

        const versionId = await step.run({ name: "resolve-target-version" }, async () =>
            Effect.runPromise(resolveTargetVersion(row, input.versionId))
        );

        if (row.binding.lastSyncedVersionId === versionId) {
            if (input.deliveryId) {
                await step.run({ name: "mark-webhook-duplicate" }, async () =>
                    Effect.runPromise(markWebhookDuplicate(row.connector.provider, input.deliveryId!))
                );
            }
            return { skipped: true, versionId };
        }

        if (!row.binding.lastSyncedVersionId) {
            const snapshot = await step.run({ name: "load-provider-snapshot" }, async () => Effect.runPromise(loadSnapshot(row, versionId)));
            if (snapshot.files.length === 0) {
                await step.run({ name: "mark-empty-binding-synced" }, async () =>
                    Effect.runPromise(markBindingSynced(row.binding.id, versionId, input.cursor))
                );
                return { versionId, fileCount: 0 };
            }

            const created = await step.run({ name: "commit-external-files" }, async () =>
                Effect.runPromise(insertConnectorFiles(row, snapshot.files, versionId, input.cursor))
            );
            await Effect.runPromise(runProcessFilesWithCleanup(step, row.binding.graphId, created, []));

            await step.run({ name: "mark-binding-synced" }, async () =>
                Effect.runPromise(markBindingSynced(row.binding.id, versionId, input.cursor))
            );
            return { versionId, fileCount: created.fileIds.length };
        }

        const activeFileRows = await step.run({ name: "load-active-binding-files" }, async () =>
            Effect.runPromise(loadActiveBindingFiles(row.binding.id))
        );
        const activeFiles = activeFilesByPath(activeFileRows);
        const delta = await step.run({ name: "compare-resource-versions" }, async () =>
            Effect.runPromise(compareResourceVersions(row, row.binding.lastSyncedVersionId!, versionId))
        );
        if (!delta.isIncremental) {
            const snapshot = await step.run({ name: "load-provider-snapshot" }, async () => Effect.runPromise(loadSnapshot(row, versionId)));
            const retiredFileIds = [...activeFiles.values()].map((file) => file.id);
            assertBindingSnapshotLimits(activeFiles, retiredFileIds, snapshot.files);

            if (snapshot.files.length > 0) {
                const created = await step.run({ name: "commit-external-files" }, async () =>
                    Effect.runPromise(insertConnectorFiles(row, snapshot.files, versionId, input.cursor))
                );
                await Effect.runPromise(runProcessFilesWithCleanup(step, row.binding.graphId, created, retiredFileIds));

                await step.run({ name: "mark-binding-synced" }, async () =>
                    Effect.runPromise(markBindingSynced(row.binding.id, versionId, input.cursor))
                );
                return { versionId, fileCount: created.fileIds.length };
            }

            if (retiredFileIds.length > 0) {
                await step.runWorkflow(processFilesSpec, {
                    graphId: row.binding.graphId,
                    fileIds: [],
                    code: { kind: "repository", retiredFileIds },
                });
            }
            await step.run({ name: "mark-binding-synced" }, async () =>
                Effect.runPromise(markBindingSynced(row.binding.id, versionId, input.cursor))
            );
            return { versionId, fileCount: 0 };
        }

        const plan = planIncrementalChanges(activeFiles, delta.changes);
        if (plan.newPaths.length === 0 && plan.retiredFileIds.length === 0) {
            await step.run({ name: "mark-binding-synced" }, async () =>
                Effect.runPromise(markBindingSynced(row.binding.id, versionId, input.cursor))
            );
            return { versionId, fileCount: 0 };
        }

        const changedFiles =
            plan.newPaths.length > 0
                ? await step.run({ name: "load-changed-files" }, async () =>
                      Effect.runPromise(loadChangedFiles(row, versionId, plan.newPaths))
                  )
                : [];
        assertBindingSnapshotLimits(activeFiles, plan.retiredFileIds, changedFiles);

        if (changedFiles.length > 0) {
            const created = await step.run({ name: "commit-external-files" }, async () =>
                Effect.runPromise(insertConnectorFiles(row, changedFiles, versionId, input.cursor))
            );
            await Effect.runPromise(runProcessFilesWithCleanup(step, row.binding.graphId, created, plan.retiredFileIds));
            await step.run({ name: "mark-binding-synced" }, async () =>
                Effect.runPromise(markBindingSynced(row.binding.id, versionId, input.cursor))
            );
            return { versionId, fileCount: created.fileIds.length };
        }

        await step.runWorkflow(processFilesSpec, {
            graphId: row.binding.graphId,
            fileIds: [],
            code: { kind: "repository", retiredFileIds: plan.retiredFileIds },
        });
        await step.run({ name: "mark-binding-synced" }, async () =>
            Effect.runPromise(markBindingSynced(row.binding.id, versionId, input.cursor))
        );
        return { versionId, fileCount: 0 };
    } catch (error) {
        if (run.retryTerminal) {
            await step.run({ name: "mark-binding-failed", retryPolicy: NO_RETRY }, async () =>
                Effect.runPromise(markBindingFailed(input.bindingId))
            );
        }

        throw error;
    }
});
