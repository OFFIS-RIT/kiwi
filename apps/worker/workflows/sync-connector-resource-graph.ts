import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import {
    ConnectorProviderError,
    MAX_REPOSITORY_CODE_BYTES as MAX_CONNECTOR_CODE_BYTES,
    MAX_REPOSITORY_CODE_FILES as MAX_CONNECTOR_CODE_FILES,
    createConnectorAdapter,
    normalizeGitLabBaseUrl,
} from "@kiwi/connectors";
import { UnsupportedSyncStrategyError } from "@kiwi/sync";
import { putNamedFile } from "@kiwi/files";
import type { FileStorage } from "@kiwi/files";
import { inferGraphFileType } from "@kiwi/graph/file-type";
import type {
    SyncDelta,
    SyncSnapshot,
    SyncStrategyKind,
    SyncedExternalItem,
    SyncedExternalItemChange,
} from "@kiwi/sync";
import type {
    ConnectorAdapter,
    ConnectorCredentials,
    ConnectorInstallationCredentials,
    ConnectorProvider,
    ConnectorResourceChange,
    ConnectorResourceDelta,
    ConnectorResourceKind,
    ConnectorResourceVersion,
    ConnectorResourceSnapshot,
    GitLabConnectorCredentials,
    ProviderCodeFile,
} from "@kiwi/connectors";
import {
    decryptConnectorCredentials,
    isConnectorCredentialsForProvider,
    isInstallationCredentialsForProvider,
} from "@kiwi/connectors/credentials";
import type { Database, DatabaseTransaction } from "@kiwi/db/effect";
import {
    connectorInstallationsTable,
    connectorsTable,
    connectorResourceBindingsTable,
    connectorWebhookEventsTable,
} from "@kiwi/db/tables/connectors";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import type { ProcessRunStatus } from "@kiwi/db/tables/graph";
import { serializeCodeFileMetadata } from "@kiwi/graph/code/metadata";
import { and, eq, inArray } from "@kiwi/db/drizzle";
import { defineWorkflow } from "openworkflow";
import type { Workflow } from "openworkflow";
import { parseCodeFileMetadata } from "../lib/code/metadata";
import { env } from "../env";
import { deleteFileSpec } from "./delete-file-spec";
import { processFilesSpec } from "./process-files-spec";
import { syncConnectorResourceGraphSpec } from "./sync-connector-resource-graph-spec";
import { runWorkerEffect, withWorkerDb, withWorkerDbVoid } from "../lib/runtime/effect";

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

type CodeSyncedExternalItem = SyncedExternalItem & {
    providerItemId: string;
    path: string;
    displayName: string;
    size: number;
    checksum: string;
    webUrl: string;
    versionId: string;
    versionName?: string;
    defaultBranch?: string;
    contentAccessMode: "text";
    processingKind: "code";
    textContent: string;
};

type StoredSyncedExternalItem = SyncedExternalItem & {
    providerItemId: string;
    path: string;
    displayName: string;
    size: number;
    checksum: string;
    mimeType: string;
    contentType: string;
    versionId: string;
    contentAccessMode: "text" | "binary";
    processingKind: "document" | "media";
    storageKey: string;
};

type LoadedSyncedExternalItem = CodeSyncedExternalItem | StoredSyncedExternalItem;

type CodeSyncSnapshot = Omit<SyncSnapshot, "items"> & {
    items: readonly CodeSyncedExternalItem[];
    defaultBranch?: string;
};

type ActiveBindingFile = {
    id: string;
    branch?: string;
    size: number;
    path: string;
    providerItemId?: string;
};

type ActiveBindingFiles = {
    byPath: Map<string, ActiveBindingFile>;
    byProviderItemId: Map<string, ActiveBindingFile>;
};

type PlannedSyncItem = {
    path: string;
    providerItemId?: string;
    parentProviderItemId?: string | null;
    displayName?: string;
    mimeType?: string;
    contentType?: string;
    size?: number;
    checksum?: string;
    etag?: string;
    webUrl?: string;
    rawUrl?: string;
    contentAccessMode?: SyncedExternalItem["contentAccessMode"];
    processingKind?: SyncedExternalItem["processingKind"];
};

type IncrementalSyncPlan = {
    newItems: PlannedSyncItem[];
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
    type: string;
    mimeType: string;
    key: string;
    storageKind: "external" | "internal";
    externalUrl: string | null;
    externalProvider: string;
    connectorBindingId: string;
    checksum: string;
    metadata: string;
    id: string;
};

type CompatibleCodeFileMetadata = {
    path: string;
    providerFileId?: string;
    versionId?: string;
    git?: { commitSha?: string; branch?: string; defaultBranch?: string };
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
        defaultBranch?: string;
    };
};
type WorkflowStep = Pick<Parameters<Workflow<unknown, unknown, unknown>["fn"]>[0]["step"], "run" | "runWorkflow">;

const NO_RETRY = { maximumAttempts: 1 } as const;
const PROVIDER_FILE_READ_CONCURRENCY = 4;

function loadBindingGraph(bindingId: string): Effect.Effect<BindingGraphRow | null, unknown, Database> {
    return Effect.map(
        withWorkerDb((db) =>
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
        ),
        ([row]) => row ?? null
    );
}

function isGitLabConnectorCredentials(value: ConnectorCredentials): value is GitLabConnectorCredentials {
    return value.provider === "gitlab";
}

function connectorProvider(row: BindingGraphRow): ConnectorProvider {
    return row.connector.provider;
}

function connectorResourceKind(row: BindingGraphRow): ConnectorResourceKind {
    return row.binding.resourceKind;
}

function requireBindingVersionName(row: BindingGraphRow): string {
    if (!row.binding.versionName) {
        throw new UnsupportedSyncStrategyError({
            strategy: "versioned-resource",
            message: "Versioned resource sync requires a binding version name",
        });
    }
    return row.binding.versionName;
}

function createAdapterContext(row: BindingGraphRow): Effect.Effect<ConnectorAdapterContext, unknown> {
    return Effect.gen(function* () {
        const provider = connectorProvider(row);
        const connectorCredentials = decryptConnectorCredentials(row.connector.encryptedCredentials, env.AUTH_SECRET);
        if (!isConnectorCredentialsForProvider(connectorCredentials, provider)) {
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

function readStoredInstallationCredentials(
    row: BindingGraphRow,
    provider: ConnectorProvider
): ConnectorInstallationCredentials {
    if (!row.installation.encryptedCredentials) {
        throw new Error("Invalid connector installation credentials");
    }
    const installationCredentials = decryptConnectorCredentials(row.installation.encryptedCredentials, env.AUTH_SECRET);
    if (!isInstallationCredentialsForProvider(installationCredentials, provider)) {
        throw new Error("Invalid connector installation credentials");
    }
    return installationCredentials;
}

const selectConnectorSyncStrategy = Effect.fn("selectConnectorSyncStrategy")(function* (adapter: ConnectorAdapter) {
    const capabilities = adapter.capabilities;
    if (!capabilities) {
        return yield* Effect.fail(
            new UnsupportedSyncStrategyError({
                strategy: "unknown",
                message: "Connector adapter did not declare sync capabilities",
            })
        );
    }
    if (capabilities.versions) {
        return "versioned-resource";
    }
    if (capabilities.cursorSync) {
        return "cursor";
    }
    if (capabilities.children) {
        return "hierarchical-snapshot";
    }
    if (capabilities.binaryFiles) {
        return "binary-document";
    }
    return yield* Effect.fail(
        new UnsupportedSyncStrategyError({
            strategy: "unknown",
            message: "Connector adapter does not advertise a supported sync capability",
        })
    );
});

const selectBindingSyncStrategy = Effect.fn("selectBindingSyncStrategy")(function* (row: BindingGraphRow) {
    const { adapter } = yield* createAdapterContext(row);
    return yield* selectConnectorSyncStrategy(adapter);
});

const requireVersionedSyncStrategy = Effect.fn("requireVersionedSyncStrategy")(function* (strategy: SyncStrategyKind) {
    if (strategy === "versioned-resource") {
        return;
    }
    return yield* Effect.fail(
        new UnsupportedSyncStrategyError({
            strategy,
            message: `Connector sync strategy "${strategy}" is not supported by resource graph sync yet`,
        })
    );
});

function resolveTargetVersion(
    row: BindingGraphRow,
    inputVersionId?: string,
    versionNameOverride?: string
): Effect.Effect<string, unknown> {
    if (inputVersionId) {
        return Effect.succeed(inputVersionId);
    }

    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        const versionName = versionNameOverride ?? requireBindingVersionName(row);
        const version = (yield* adapter.listResourceVersions(row.binding.providerResourceId)).find(
            (candidate) => candidate.name === versionName
        );
        if (!version) {
            return yield* Effect.fail(
                new ConnectorProviderError("not-found", "Connector resource version was not found")
            );
        }

        return version.versionId;
    });
}

function loadSnapshot(
    row: BindingGraphRow,
    versionId: string,
    versionNameOverride?: string
): Effect.Effect<CodeSyncSnapshot, unknown> {
    const versionName = versionNameOverride ?? requireBindingVersionName(row);
    return loadSnapshotVersion(row, versionName, versionId);
}

function loadSnapshotVersion(
    row: BindingGraphRow,
    versionName: string,
    versionId: string
): Effect.Effect<CodeSyncSnapshot, unknown> {
    return Effect.gen(function* () {
        const context = yield* createAdapterContext(row);
        const snapshot = yield* context.adapter.loadSnapshot(row.binding.providerResourceId, versionName, versionId);
        return connectorSnapshotToSyncSnapshot(row, snapshot);
    });
}

function listBranchVersions(row: BindingGraphRow): Effect.Effect<ConnectorResourceVersion[], unknown> {
    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        return yield* adapter.listResourceVersions(row.binding.providerResourceId);
    });
}

function resolveRepositoryDefaultBranch(row: BindingGraphRow): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        const resource = yield* adapter.getResource(row.binding.providerResourceId);
        return resource.defaultBranch ?? resource.defaultVersion?.name ?? row.binding.versionName ?? "default";
    });
}

function compareResourceVersions(
    row: BindingGraphRow,
    fromVersionId: string,
    toVersionId: string
): Effect.Effect<SyncDelta, unknown> {
    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        const delta = yield* adapter.compareVersions(row.binding.providerResourceId, fromVersionId, toVersionId);
        return connectorDeltaToSyncDelta(delta);
    });
}

function listCursorChanges(row: BindingGraphRow, cursor?: string): Effect.Effect<SyncDelta, unknown> {
    return Effect.gen(function* () {
        const { adapter } = yield* createAdapterContext(row);
        if (!adapter.listChanges) {
            return yield* Effect.fail(
                new UnsupportedSyncStrategyError({
                    strategy: "cursor",
                    message: "Connector adapter advertised cursor sync without listChanges",
                })
            );
        }
        const changeSet = yield* adapter.listChanges(row.binding.providerResourceId, cursor);
        return {
            isIncremental: !changeSet.isInitial,
            fromVersionId: cursor,
            toVersionId: changeSet.versionId ?? changeSet.cursor,
            cursor: changeSet.cursor,
            changes: changeSet.changes.map(connectorChangeToSyncChange),
        };
    });
}

function loadChangedItems(
    row: BindingGraphRow,
    versionId: string,
    plannedItems: PlannedSyncItem[],
    versionName?: string,
    defaultBranch?: string
): Effect.Effect<LoadedSyncedExternalItem[], unknown, FileStorage> {
    return Effect.gen(function* () {
        const context = yield* createAdapterContext(row);
        const items: LoadedSyncedExternalItem[] = [];
        for (let index = 0; index < plannedItems.length; index += PROVIDER_FILE_READ_CONCURRENCY) {
            const batch = plannedItems.slice(index, index + PROVIDER_FILE_READ_CONCURRENCY);
            items.push(
                ...(yield* Effect.all(
                    batch.map((plannedItem) =>
                        loadChangedItem(row, context, versionId, plannedItem, versionName, defaultBranch)
                    ),
                    { concurrency: PROVIDER_FILE_READ_CONCURRENCY }
                ))
            );
        }
        return items;
    });
}

function loadChangedItem(
    row: BindingGraphRow,
    context: ConnectorAdapterContext,
    versionId: string,
    plannedItem: PlannedSyncItem,
    versionName?: string,
    defaultBranch?: string
): Effect.Effect<LoadedSyncedExternalItem, unknown, FileStorage> {
    if (plannedItem.processingKind === "document" || plannedItem.processingKind === "media") {
        return loadStoredSyncItem(row, context, versionId, plannedItem);
    }

    if (
        plannedItem.processingKind !== undefined &&
        (plannedItem.processingKind !== "code" || plannedItem.contentAccessMode !== "text")
    ) {
        return Effect.fail(
            new UnsupportedSyncStrategyError({
                strategy: "cursor",
                message: "Only text code connector items can use repository processing",
            })
        );
    }

    return Effect.map(
        context.adapter.readFile({
            resourceId: row.binding.providerResourceId,
            path: plannedItem.path,
            versionId,
            resourceKind: row.binding.resourceKind,
        }),
        (content) => buildCodeSyncItem(row, context, versionId, plannedItem, content, versionName, defaultBranch)
    );
}

function plannedItemDisplayName(item: PlannedSyncItem): string {
    return item.displayName ?? item.path.split("/").at(-1) ?? item.path;
}

function loadStoredSyncItem(
    row: BindingGraphRow,
    context: ConnectorAdapterContext,
    versionId: string,
    plannedItem: PlannedSyncItem
): Effect.Effect<StoredSyncedExternalItem, unknown, FileStorage> {
    return Effect.gen(function* () {
        const loaded =
            plannedItem.contentAccessMode === "binary"
                ? yield* loadBinarySyncItem(row, context, versionId, plannedItem)
                : plannedItem.contentAccessMode === "text"
                  ? yield* loadTextFileSyncItem(row, context, versionId, plannedItem)
                  : yield* Effect.fail(
                        new UnsupportedSyncStrategyError({
                            strategy: "cursor",
                            message: "External connector items must expose text or binary content before processing",
                            capability: "binaryFiles",
                        })
                    );
        const uploaded = yield* putNamedFile(
            loaded.displayName,
            loaded.bytes,
            `graphs/${row.binding.graphId}/connector-resources/${row.binding.id}/${versionId}`,
            env.S3_BUCKET
        );
        return {
            ...plannedItem,
            providerItemId: plannedItem.providerItemId ?? plannedItem.path,
            displayName: loaded.displayName,
            size: loaded.size,
            checksum: plannedItem.checksum ?? createContentChecksum(loaded.bytes),
            mimeType: loaded.mimeType,
            contentType: loaded.contentType,
            versionId,
            contentAccessMode: plannedItem.contentAccessMode as "text" | "binary",
            processingKind: plannedItem.processingKind as "document" | "media",
            storageKey: uploaded.key,
        };
    });
}

function loadBinarySyncItem(
    row: BindingGraphRow,
    context: ConnectorAdapterContext,
    versionId: string,
    plannedItem: PlannedSyncItem
): Effect.Effect<
    {
        bytes: Uint8Array;
        displayName: string;
        size: number;
        mimeType: string;
        contentType: string;
    },
    unknown
> {
    if (!context.adapter.openFile) {
        return Effect.fail(
            new UnsupportedSyncStrategyError({
                strategy: "cursor",
                message: "Connector adapter advertised binary files without openFile",
                capability: "binaryFiles",
            })
        );
    }
    return Effect.map(
        context.adapter.openFile({
            resourceId: row.binding.providerResourceId,
            path: plannedItem.path,
            versionId,
            etag: plannedItem.etag,
            resourceKind: row.binding.resourceKind,
        }),
        (file) => {
            const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
            const contentType =
                file.contentType ?? plannedItem.contentType ?? plannedItem.mimeType ?? "application/octet-stream";
            return {
                bytes,
                displayName: plannedItemDisplayName(plannedItem),
                size: file.size ?? plannedItem.size ?? bytes.byteLength,
                mimeType: plannedItem.mimeType ?? contentType,
                contentType,
            };
        }
    );
}

function loadTextFileSyncItem(
    row: BindingGraphRow,
    context: ConnectorAdapterContext,
    versionId: string,
    plannedItem: PlannedSyncItem
): Effect.Effect<
    {
        bytes: Uint8Array;
        displayName: string;
        size: number;
        mimeType: string;
        contentType: string;
    },
    unknown
> {
    return Effect.map(
        context.adapter.readFile({
            resourceId: row.binding.providerResourceId,
            path: plannedItem.path,
            versionId,
            resourceKind: row.binding.resourceKind,
        }),
        (content) => {
            const bytes = new TextEncoder().encode(content);
            const contentType = plannedItem.contentType ?? plannedItem.mimeType ?? "text/plain";
            return {
                bytes,
                displayName: plannedItemDisplayName(plannedItem),
                size: plannedItem.size ?? bytes.byteLength,
                mimeType: plannedItem.mimeType ?? contentType,
                contentType,
            };
        }
    );
}

function createContentChecksum(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function connectorSnapshotToSyncSnapshot(row: BindingGraphRow, snapshot: ConnectorResourceSnapshot): CodeSyncSnapshot {
    const defaultBranch = snapshot.resource.defaultBranch ?? snapshot.resource.defaultVersion?.name ?? undefined;
    return {
        resourceId: snapshot.resource.id,
        versionName: snapshot.version.name,
        versionId: snapshot.version.versionId,
        ...(defaultBranch ? { defaultBranch } : {}),
        items: snapshot.files.map((file) =>
            providerCodeFileToSyncItem(row, snapshot.version.name, snapshot.version.versionId, file, defaultBranch)
        ),
    };
}

function connectorDeltaToSyncDelta(delta: ConnectorResourceDelta): SyncDelta {
    return {
        isIncremental: delta.isIncremental,
        fromVersionId: delta.fromVersionId,
        toVersionId: delta.toVersionId,
        changes: delta.changes.map(connectorChangeToSyncChange),
    };
}

function connectorChangeToSyncChange(change: ConnectorResourceChange): SyncedExternalItemChange {
    const record = change as ConnectorResourceChange & Record<string, unknown>;
    const providerItemId =
        typeof record.providerItemId === "string"
            ? record.providerItemId
            : change.status === "deleted"
              ? change.oldPath
              : change.newPath;
    const path =
        typeof record.path === "string"
            ? record.path
            : typeof record.newPath === "string"
              ? record.newPath
              : change.status === "deleted"
                ? change.oldPath
                : undefined;
    const displayName = typeof record.displayName === "string" ? record.displayName : undefined;
    const parentProviderItemId =
        typeof record.parentProviderItemId === "string" || record.parentProviderItemId === null
            ? record.parentProviderItemId
            : undefined;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
    const contentType = typeof record.contentType === "string" ? record.contentType : undefined;
    const size = typeof record.size === "number" ? record.size : undefined;
    const checksum = typeof record.checksum === "string" ? record.checksum : undefined;
    const etag = typeof record.etag === "string" ? record.etag : undefined;
    const webUrl = typeof record.webUrl === "string" ? record.webUrl : undefined;
    const rawUrl = typeof record.rawUrl === "string" ? record.rawUrl : undefined;
    const contentAccessMode =
        record.contentAccessMode === "text" ||
        record.contentAccessMode === "binary" ||
        record.contentAccessMode === "external" ||
        record.contentAccessMode === "unavailable"
            ? record.contentAccessMode
            : undefined;
    const processingKind =
        record.processingKind === "code" || record.processingKind === "document" || record.processingKind === "media"
            ? record.processingKind
            : undefined;
    const item: SyncedExternalItem | undefined =
        change.status === "deleted" || !path
            ? undefined
            : {
                  providerItemId,
                  ...(parentProviderItemId !== undefined ? { parentProviderItemId } : {}),
                  path,
                  displayName: displayName ?? path.split("/").at(-1) ?? path,
                  ...(mimeType ? { mimeType } : {}),
                  ...(contentType ? { contentType } : {}),
                  ...(size !== undefined ? { size } : {}),
                  ...(checksum ? { checksum } : {}),
                  ...(etag ? { etag } : {}),
                  ...(webUrl ? { webUrl } : {}),
                  ...(rawUrl ? { rawUrl } : {}),
                  contentAccessMode: contentAccessMode ?? "text",
                  processingKind: processingKind ?? "code",
              };
    switch (change.status) {
        case "added":
        case "modified":
            return { status: change.status, providerItemId, path, ...(item ? { item } : {}) };
        case "deleted":
            return { status: "deleted", providerItemId, path };
        case "renamed":
            return {
                status: "renamed",
                providerItemId,
                oldPath: change.oldPath,
                path,
                ...(item ? { item } : {}),
            };
    }
}

function loadActiveBindingFiles(
    bindingId: string,
    branch?: string
): Effect.Effect<ActiveBindingFile[], unknown, Database> {
    return Effect.gen(function* () {
        const rows = yield* withWorkerDb((db) =>
            db
                .select({
                    id: filesTable.id,
                    size: filesTable.size,
                    metadata: filesTable.metadata,
                })
                .from(filesTable)
                .where(and(eq(filesTable.connectorBindingId, bindingId), eq(filesTable.deleted, false)))
        );

        const filesByPath = new Map<string, ActiveBindingFile>();
        for (const row of rows) {
            const metadata = parseCodeFileMetadata(row.metadata) as CompatibleCodeFileMetadata | null;
            if (!metadata) {
                return yield* Effect.fail(new Error(`Active connector file ${row.id} is missing connector metadata`));
            }
            const fileBranch = metadata.git?.branch ?? metadata.git?.defaultBranch ?? branch ?? "default";
            if (branch && fileBranch !== branch) {
                continue;
            }
            if (filesByPath.has(metadata.path)) {
                return yield* Effect.fail(
                    new Error(
                        `Connector binding ${bindingId} has multiple active rows for ${metadata.path} on ${fileBranch}`
                    )
                );
            }
            filesByPath.set(metadata.path, {
                id: row.id,
                branch: fileBranch,
                size: row.size,
                path: metadata.path,
                ...(metadata.providerFileId ? { providerItemId: metadata.providerFileId } : {}),
            });
        }

        return [...filesByPath.values()];
    });
}

function activeBindingFiles(files: ActiveBindingFile[]): ActiveBindingFiles {
    const byPath = new Map<string, ActiveBindingFile>();
    const byProviderItemId = new Map<string, ActiveBindingFile>();
    for (const file of files) {
        byPath.set(file.path, file);
        if (file.providerItemId) {
            byProviderItemId.set(file.providerItemId, file);
        }
    }
    return { byPath, byProviderItemId };
}

function planIncrementalChanges(
    activeFiles: ActiveBindingFiles,
    changes: readonly SyncedExternalItemChange[]
): IncrementalSyncPlan {
    const seenLocators = new Set<string>();
    const newItems: PlannedSyncItem[] = [];
    const retiredFileIds = new Set<string>();

    const trackLocator = (path?: string, providerItemId?: string) => {
        const locator = path ? { key: `path:${path}`, label: `path ${path}` } : null;
        const itemLocator = providerItemId ? { key: `item:${providerItemId}`, label: `item ${providerItemId}` } : null;
        const selected = locator ?? itemLocator;
        if (!selected) {
            throw new UnsupportedSyncStrategyError({
                strategy: "versioned-resource",
                message: "Connector deltas require a path or provider item id",
            });
        }
        if (seenLocators.has(selected.key)) {
            throw new Error(`Provider delta contained duplicate ${selected.label}`);
        }
        seenLocators.add(selected.key);
    };

    const retireLocator = (path?: string, providerItemId?: string) => {
        const activeFile =
            (providerItemId ? activeFiles.byProviderItemId.get(providerItemId) : undefined) ??
            (path ? activeFiles.byPath.get(path) : undefined);
        if (activeFile) {
            retiredFileIds.add(activeFile.id);
        }
    };

    const plannedItem = (change: SyncedExternalItemChange): PlannedSyncItem => {
        const item = "item" in change ? change.item : undefined;
        const path = item?.path ?? ("path" in change ? change.path : undefined);
        if (!path) {
            throw new UnsupportedSyncStrategyError({
                strategy: "versioned-resource",
                message: "Connector deltas require paths for added, modified, and renamed items",
            });
        }
        return {
            path,
            ...(change.providerItemId ? { providerItemId: change.providerItemId } : {}),
            ...(item?.parentProviderItemId !== undefined ? { parentProviderItemId: item.parentProviderItemId } : {}),
            ...(item?.displayName ? { displayName: item.displayName } : {}),
            ...(item?.mimeType ? { mimeType: item.mimeType } : {}),
            ...(item?.contentType ? { contentType: item.contentType } : {}),
            ...(item?.size !== undefined ? { size: item.size } : {}),
            ...(item?.checksum ? { checksum: item.checksum } : {}),
            ...(item?.etag ? { etag: item.etag } : {}),
            ...(item?.webUrl ? { webUrl: item.webUrl } : {}),
            ...(item?.rawUrl ? { rawUrl: item.rawUrl } : {}),
            ...(item?.contentAccessMode ? { contentAccessMode: item.contentAccessMode } : {}),
            ...(item?.processingKind ? { processingKind: item.processingKind } : {}),
        };
    };

    for (const change of changes) {
        switch (change.status) {
            case "added":
            case "modified": {
                const item = plannedItem(change);
                trackLocator(item.path, item.providerItemId);
                newItems.push(item);
                retireLocator(item.path, item.providerItemId);
                break;
            }
            case "deleted":
                trackLocator(change.path, change.providerItemId);
                retireLocator(change.path, change.providerItemId);
                break;
            case "renamed": {
                if (change.oldPath) {
                    trackLocator(change.oldPath);
                }
                const item = plannedItem(change);
                trackLocator(item.path, item.providerItemId);
                retireLocator(change.oldPath, item.providerItemId);
                retireLocator(item.path, item.providerItemId);
                newItems.push(item);
                break;
            }
        }
    }

    return {
        newItems,
        retiredFileIds: [...retiredFileIds],
    };
}

function buildCodeSyncItem(
    row: BindingGraphRow,
    context: ConnectorAdapterContext,
    versionId: string,
    plannedItem: PlannedSyncItem,
    content: string,
    versionName?: string,
    defaultBranch?: string
): CodeSyncedExternalItem {
    const urls = gitFileUrls(row, context, versionId, plannedItem.path);
    const parentPathEnd = plannedItem.path.lastIndexOf("/");
    const contentChecksum = createHash("sha256").update(content, "utf8").digest("hex");
    return {
        providerItemId: plannedItem.providerItemId ?? plannedItem.path,
        parentProviderItemId:
            plannedItem.parentProviderItemId !== undefined
                ? plannedItem.parentProviderItemId
                : parentPathEnd > 0
                  ? plannedItem.path.slice(0, parentPathEnd)
                  : null,
        path: plannedItem.path,
        displayName: plannedItem.displayName ?? plannedItem.path.split("/").at(-1) ?? plannedItem.path,
        mimeType: plannedItem.mimeType ?? "text/plain",
        contentType: plannedItem.contentType ?? plannedItem.mimeType ?? "text/plain",
        size: Buffer.byteLength(content, "utf8"),
        checksum: plannedItem.checksum ?? contentChecksum,
        webUrl: plannedItem.webUrl ?? urls.webUrl,
        ...((plannedItem.rawUrl ?? urls.rawUrl) ? { rawUrl: plannedItem.rawUrl ?? urls.rawUrl } : {}),
        ...(plannedItem.etag ? { etag: plannedItem.etag } : {}),
        ...((versionName ?? row.binding.versionName) ? { versionName: versionName ?? row.binding.versionName! } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        versionId,
        contentAccessMode: "text",
        processingKind: "code",
        textContent: content,
    };
}

function providerCodeFileToSyncItem(
    row: BindingGraphRow,
    versionName: string,
    versionId: string,
    file: ProviderCodeFile,
    defaultBranch?: string
): CodeSyncedExternalItem {
    const parentPathEnd = file.path.lastIndexOf("/");
    return {
        providerItemId: file.path,
        parentProviderItemId: parentPathEnd > 0 ? file.path.slice(0, parentPathEnd) : null,
        path: file.path,
        displayName: file.path.split("/").at(-1) ?? file.path,
        mimeType: "text/plain",
        contentType: "text/plain",
        size: file.size,
        checksum: file.checksum,
        webUrl: file.htmlUrl,
        ...(file.rawUrl ? { rawUrl: file.rawUrl } : {}),
        versionName,
        ...(defaultBranch ? { defaultBranch } : {}),
        versionId,
        contentAccessMode: "text",
        processingKind: "code",
        textContent: file.content,
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
    activeFiles: ActiveBindingFiles,
    retiredFileIds: string[],
    newFiles: LoadedSyncedExternalItem[]
) {
    const retiredIds = new Set(retiredFileIds);
    const totalFileCount =
        [...activeFiles.byPath.values()].filter((file) => !retiredIds.has(file.id)).length + newFiles.length;
    if (totalFileCount > MAX_CONNECTOR_CODE_FILES) {
        throw new ConnectorProviderError("limit", "Connector resource contains too many supported code files");
    }

    const totalBytes =
        [...activeFiles.byPath.values()].reduce((sum, file) => sum + (retiredIds.has(file.id) ? 0 : file.size), 0) +
        newFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_CONNECTOR_CODE_BYTES) {
        throw new ConnectorProviderError("limit", "Connector resource contains too much supported code");
    }
}

function connectorFileKey(bindingId: string, file: LoadedSyncedExternalItem, versionId: string): string {
    const fileVersionId = file.versionId ?? versionId;
    const isNonDefaultBranch =
        file.versionName !== undefined && file.defaultBranch !== undefined && file.versionName !== file.defaultBranch;
    const versionKey = isNonDefaultBranch ? `${file.versionName}:${fileVersionId}` : fileVersionId;
    return file.providerItemId !== file.path
        ? `connector:${bindingId}:${file.providerItemId}:${versionKey}`
        : `connector:${bindingId}:${versionKey}:${file.path}`;
}

function connectorFileMetadata(
    row: BindingGraphRow,
    file: LoadedSyncedExternalItem,
    versionId: string
): ConnectorFileMetadataInput {
    const fileVersionId = file.versionId ?? versionId;
    const branchName = file.versionName ?? row.binding.versionName;
    const defaultBranch = file.defaultBranch ?? branchName;
    return {
        schemaVersion: 2,
        provider: connectorProvider(row),
        bindingId: row.binding.id,
        resourceKind: connectorResourceKind(row),
        providerResourceId: row.binding.providerResourceId,
        resourceDisplayName: row.binding.resourceDisplayName,
        path: file.path,
        displayName: file.displayName,
        ...(fileVersionId ? { versionId: fileVersionId } : {}),
        providerFileId: file.providerItemId,
        ...(file.etag ? { etag: file.etag } : {}),
        webUrl: file.webUrl,
        ...(file.rawUrl ? { rawUrl: file.rawUrl } : {}),
        ...(row.binding.resourceKind === "git-repository" && fileVersionId
            ? {
                  git: {
                      repositoryName: row.binding.resourceDisplayName,
                      repositoryUrl: row.binding.resourceWebUrl,
                      commitSha: fileVersionId,
                      ...(branchName ? { branch: branchName } : {}),
                      ...(defaultBranch ? { defaultBranch } : {}),
                  },
              }
            : {}),
    };
}

function fileRows(row: BindingGraphRow, files: LoadedSyncedExternalItem[], versionId: string): ConnectorFileRow[] {
    return files.map((file) => {
        const key = connectorFileKey(row.binding.id, file, versionId);
        const fileVersionId = file.versionId ?? versionId;
        const metadata = serializeCodeFileMetadata(connectorFileMetadata(row, file, versionId));
        if (file.processingKind !== "code") {
            return {
                graphId: row.binding.graphId,
                name: file.path,
                size: file.size,
                type: inferGraphFileType({ name: file.displayName, type: file.mimeType }),
                mimeType: file.mimeType,
                key: file.storageKey,
                storageKind: "external",
                externalUrl: file.webUrl ?? file.rawUrl ?? row.binding.resourceWebUrl,
                externalProvider: row.connector.provider,
                connectorBindingId: row.binding.id,
                checksum: `${fileVersionId}:${file.providerItemId}:${file.checksum}`,
                metadata,
                id: crypto.randomUUID(),
            };
        }

        return {
            graphId: row.binding.graphId,
            name: file.path,
            size: file.size,
            type: "code",
            mimeType: "text/plain",
            key,
            storageKind: "external",
            externalUrl: file.webUrl ?? file.rawUrl ?? row.binding.resourceWebUrl,
            externalProvider: row.connector.provider,
            connectorBindingId: row.binding.id,
            checksum: `${fileVersionId}:${file.providerItemId}:${file.checksum}`,
            metadata,
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
    tx: DatabaseTransaction,
    graphId: string,
    fileIds: string[]
): Effect.Effect<ReusableProcessRun | null, unknown> {
    return Effect.gen(function* () {
        if (fileIds.length === 0) {
            return null;
        }

        const matchingRunRows = yield* tx
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

        const runFileRows = yield* tx
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

        exactCandidates.sort(
            (left, right) => processRunStatusPriority(left.status) - processRunStatusPriority(right.status)
        );
        return exactCandidates[0] ?? null;
    });
}

function insertConnectorFiles(
    row: BindingGraphRow,
    files: LoadedSyncedExternalItem[],
    versionId: string,
    cursor?: string
): Effect.Effect<InsertedConnectorFiles, unknown, Database> {
    return withWorkerDb((db) =>
        db.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx
                    .update(connectorResourceBindingsTable)
                    .set({
                        syncStatus: "syncing",
                        lastSeenVersionId: versionId,
                        syncErrorCode: null,
                        ...(cursor !== undefined ? { syncCursor: cursor } : {}),
                    })
                    .where(eq(connectorResourceBindingsTable.id, row.binding.id));

                const rows = fileRows(row, files, versionId);
                const insertedFiles = yield* tx
                    .insert(filesTable)
                    .values(rows)
                    .onConflictDoNothing()
                    .returning({ id: filesTable.id, key: filesTable.key });
                let committedFiles = orderedFilesByKey(rows, insertedFiles);
                if (committedFiles.length !== files.length) {
                    const existingFiles = yield* tx
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
                    return yield* Effect.fail(new Error("Failed to insert all connector files"));
                }

                const fileIds = committedFiles.map((file) => file.id);
                if (insertedFiles.length === 0) {
                    const reusableProcessRun = yield* findReusableProcessRun(tx, row.binding.graphId, fileIds);
                    if (reusableProcessRun) {
                        return {
                            fileIds,
                            processRunId: reusableProcessRun.id,
                            processRunStatus: reusableProcessRun.status,
                        };
                    }
                }

                const [processRun] = yield* tx
                    .insert(processRunsTable)
                    .values({ graphId: row.binding.graphId, status: "pending" })
                    .returning({ id: processRunsTable.id });
                if (!processRun) {
                    return yield* Effect.fail(new Error("Failed to create process run"));
                }

                yield* tx.insert(processRunFilesTable).values(
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
        )
    );
}

function markWebhookDuplicate(
    connectorId: string,
    provider: typeof connectorsTable.$inferSelect.provider,
    deliveryId: string
) {
    return withWorkerDbVoid((db) =>
        db
            .update(connectorWebhookEventsTable)
            .set({ status: "duplicate" })
            .where(
                and(
                    eq(connectorWebhookEventsTable.connectorId, connectorId),
                    eq(connectorWebhookEventsTable.provider, provider),
                    eq(connectorWebhookEventsTable.deliveryId, deliveryId)
                )
            )
    );
}

function markBindingSynced(bindingId: string, versionId: string, cursor?: string) {
    return withWorkerDbVoid((db) =>
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
    );
}

function markBindingFailed(bindingId: string) {
    return withWorkerDbVoid((db) =>
        db
            .update(connectorResourceBindingsTable)
            .set({ syncStatus: "failed", syncErrorCode: "sync_failed" })
            .where(eq(connectorResourceBindingsTable.id, bindingId))
    );
}

function workflowStepSuffix(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 48) || "branch";
}

async function indexDiscoveredFastBranches(
    step: WorkflowStep,
    row: BindingGraphRow,
    defaultBranchName: string
): Promise<number> {
    const versions = await step.run({ name: "list-fast-branch-versions" }, async () =>
        runWorkerEffect(listBranchVersions(row))
    );
    let indexedFileCount = 0;
    let branchIndex = 0;
    const seenBranches = new Set<string>();
    for (const version of versions) {
        if (version.name === defaultBranchName || seenBranches.has(version.name)) {
            continue;
        }
        branchIndex += 1;
        seenBranches.add(version.name);
        const suffix = `${branchIndex}-${workflowStepSuffix(version.name)}`;
        const snapshot = await step.run({ name: `load-fast-branch-snapshot-${suffix}` }, async () =>
            runWorkerEffect(loadSnapshotVersion(row, version.name, version.versionId))
        );
        if (snapshot.items.length === 0) {
            continue;
        }
        const activeFileRows = await step.run({ name: `load-active-fast-branch-files-${suffix}` }, async () =>
            runWorkerEffect(loadActiveBindingFiles(row.binding.id, version.name))
        );
        const activeFiles = activeBindingFiles(activeFileRows);
        const snapshotPaths = new Set(snapshot.items.map((item) => item.path));
        const retiredFileIds = [...activeFiles.byPath.values()]
            .filter((file) => !snapshotPaths.has(file.path))
            .map((file) => file.id);
        assertBindingSnapshotLimits(activeFiles, retiredFileIds, [...snapshot.items]);
        const created = await step.run({ name: `commit-fast-branch-files-${suffix}` }, async () =>
            runWorkerEffect(insertConnectorFiles(row, [...snapshot.items], version.versionId))
        );
        await runWorkerEffect(
            runProcessFilesWithCleanup(
                step,
                row.binding.graphId,
                created,
                repositoryProcessOptions([...snapshot.items], retiredFileIds)
            )
        );
        indexedFileCount += created.fileIds.length;
    }
    return indexedFileCount;
}

function repositoryProcessOptions(
    files: readonly LoadedSyncedExternalItem[],
    retiredFileIds: string[]
): { kind: "repository"; retiredFileIds?: string[] } | undefined {
    if (retiredFileIds.length > 0 || files.some((file) => file.processingKind === "code")) {
        return { kind: "repository", retiredFileIds };
    }
    return undefined;
}

function runProcessFilesWithCleanup(
    step: WorkflowStep,
    graphId: string,
    created: InsertedConnectorFiles,
    code?: { kind: "repository"; retiredFileIds?: string[] }
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
                    ...(code ? { code } : {}),
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

export const syncConnectorResourceGraph = defineWorkflow(
    syncConnectorResourceGraphSpec,
    async ({ input, step, run }) => {
        try {
            const row = await step.run({ name: "load-binding" }, async () =>
                runWorkerEffect(loadBindingGraph(input.bindingId))
            );
            if (!row || row.connector.status !== "active" || row.installation.status !== "active") {
                return { skipped: true };
            }
            if ("syncEnabled" in row.binding && row.binding.syncEnabled === false) {
                return { skipped: true };
            }

            const syncStrategy = await step.run({ name: "select-sync-strategy" }, async () =>
                runWorkerEffect(selectBindingSyncStrategy(row))
            );
            if (syncStrategy === "cursor") {
                const activeFileRows = await step.run({ name: "load-active-binding-files" }, async () =>
                    runWorkerEffect(loadActiveBindingFiles(row.binding.id))
                );
                const activeFiles = activeBindingFiles(activeFileRows);
                const cursor =
                    input.cursor ??
                    ("syncCursor" in row.binding && typeof row.binding.syncCursor === "string"
                        ? row.binding.syncCursor
                        : undefined);
                const delta = await step.run({ name: "list-cursor-changes" }, async () =>
                    runWorkerEffect(listCursorChanges(row, cursor))
                );
                const versionId = delta.toVersionId ?? delta.cursor;
                if (!versionId) {
                    throw new UnsupportedSyncStrategyError({
                        strategy: "cursor",
                        message: "Cursor sync did not return a next cursor",
                    });
                }
                const plan = planIncrementalChanges(activeFiles, delta.changes);
                if (plan.newItems.length === 0 && plan.retiredFileIds.length === 0) {
                    await step.run({ name: "mark-binding-synced" }, async () =>
                        runWorkerEffect(markBindingSynced(row.binding.id, versionId, delta.cursor))
                    );
                    return { versionId, fileCount: 0 };
                }
                const changedItems =
                    plan.newItems.length > 0
                        ? await step.run({ name: "load-changed-files" }, async () =>
                              runWorkerEffect(loadChangedItems(row, versionId, plan.newItems))
                          )
                        : [];
                assertBindingSnapshotLimits(activeFiles, plan.retiredFileIds, changedItems);
                if (changedItems.length > 0) {
                    const created = await step.run({ name: "commit-external-files" }, async () =>
                        runWorkerEffect(insertConnectorFiles(row, changedItems, versionId, delta.cursor))
                    );
                    await runWorkerEffect(
                        runProcessFilesWithCleanup(
                            step,
                            row.binding.graphId,
                            created,
                            repositoryProcessOptions(changedItems, plan.retiredFileIds)
                        )
                    );
                    await step.run({ name: "mark-binding-synced" }, async () =>
                        runWorkerEffect(markBindingSynced(row.binding.id, versionId, delta.cursor))
                    );
                    return { versionId, fileCount: created.fileIds.length };
                }
                await step.runWorkflow(processFilesSpec, {
                    graphId: row.binding.graphId,
                    fileIds: [],
                    code: { kind: "repository", retiredFileIds: plan.retiredFileIds },
                });
                await step.run({ name: "mark-binding-synced" }, async () =>
                    runWorkerEffect(markBindingSynced(row.binding.id, versionId, delta.cursor))
                );
                return { versionId, fileCount: 0 };
            }

            await runWorkerEffect(requireVersionedSyncStrategy(syncStrategy));
            const defaultBranchName = await step.run({ name: "resolve-default-branch" }, async () =>
                runWorkerEffect(resolveRepositoryDefaultBranch(row))
            );
            const versionId = await step.run({ name: "resolve-target-version" }, async () =>
                runWorkerEffect(resolveTargetVersion(row, input.versionId, defaultBranchName))
            );
            const indexFastBranchFileCount = () => indexDiscoveredFastBranches(step, row, defaultBranchName);

            if (row.binding.lastSyncedVersionId === versionId) {
                if (input.deliveryId) {
                    await step.run({ name: "mark-webhook-duplicate" }, async () =>
                        runWorkerEffect(
                            markWebhookDuplicate(row.connector.id, row.connector.provider, input.deliveryId!)
                        )
                    );
                }
                return { skipped: true, versionId };
            }

            if (!row.binding.lastSyncedVersionId) {
                const snapshot = await step.run({ name: "load-provider-snapshot" }, async () =>
                    runWorkerEffect(loadSnapshot(row, versionId, defaultBranchName))
                );
                if (snapshot.items.length === 0) {
                    const fastBranchFileCount = await indexFastBranchFileCount();
                    await step.run({ name: "mark-empty-binding-synced" }, async () =>
                        runWorkerEffect(markBindingSynced(row.binding.id, versionId, input.cursor))
                    );
                    return { versionId, fileCount: fastBranchFileCount };
                }

                const created = await step.run({ name: "commit-external-files" }, async () =>
                    runWorkerEffect(insertConnectorFiles(row, [...snapshot.items], versionId, input.cursor))
                );
                await runWorkerEffect(
                    runProcessFilesWithCleanup(
                        step,
                        row.binding.graphId,
                        created,
                        repositoryProcessOptions([...snapshot.items], [])
                    )
                );

                const fastBranchFileCount = await indexFastBranchFileCount();
                await step.run({ name: "mark-binding-synced" }, async () =>
                    runWorkerEffect(markBindingSynced(row.binding.id, versionId, input.cursor))
                );
                return { versionId, fileCount: created.fileIds.length + fastBranchFileCount };
            }

            const activeFileRows = await step.run({ name: "load-active-binding-files" }, async () =>
                runWorkerEffect(loadActiveBindingFiles(row.binding.id, defaultBranchName))
            );
            const activeFiles = activeBindingFiles(activeFileRows);
            const delta = await step.run({ name: "compare-resource-versions" }, async () =>
                runWorkerEffect(compareResourceVersions(row, row.binding.lastSyncedVersionId!, versionId))
            );
            if (!delta.isIncremental) {
                const snapshot = await step.run({ name: "load-provider-snapshot" }, async () =>
                    runWorkerEffect(loadSnapshot(row, versionId, defaultBranchName))
                );
                const retiredFileIds = [...activeFiles.byPath.values()].map((file) => file.id);
                assertBindingSnapshotLimits(activeFiles, retiredFileIds, [...snapshot.items]);

                if (snapshot.items.length > 0) {
                    const created = await step.run({ name: "commit-external-files" }, async () =>
                        runWorkerEffect(insertConnectorFiles(row, [...snapshot.items], versionId, input.cursor))
                    );
                    await runWorkerEffect(
                        runProcessFilesWithCleanup(
                            step,
                            row.binding.graphId,
                            created,
                            repositoryProcessOptions([...snapshot.items], retiredFileIds)
                        )
                    );

                    const fastBranchFileCount = await indexFastBranchFileCount();
                    await step.run({ name: "mark-binding-synced" }, async () =>
                        runWorkerEffect(markBindingSynced(row.binding.id, versionId, input.cursor))
                    );
                    return { versionId, fileCount: created.fileIds.length + fastBranchFileCount };
                }

                if (retiredFileIds.length > 0) {
                    await step.runWorkflow(processFilesSpec, {
                        graphId: row.binding.graphId,
                        fileIds: [],
                        code: { kind: "repository", retiredFileIds },
                    });
                }
                const fastBranchFileCount = await indexFastBranchFileCount();
                await step.run({ name: "mark-binding-synced" }, async () =>
                    runWorkerEffect(markBindingSynced(row.binding.id, versionId, input.cursor))
                );
                return { versionId, fileCount: fastBranchFileCount };
            }

            const plan = planIncrementalChanges(activeFiles, delta.changes);
            if (plan.newItems.length === 0 && plan.retiredFileIds.length === 0) {
                const fastBranchFileCount = await indexFastBranchFileCount();
                await step.run({ name: "mark-binding-synced" }, async () =>
                    runWorkerEffect(markBindingSynced(row.binding.id, versionId, input.cursor))
                );
                return { versionId, fileCount: fastBranchFileCount };
            }

            const changedItems =
                plan.newItems.length > 0
                    ? await step.run({ name: "load-changed-files" }, async () =>
                          runWorkerEffect(
                              loadChangedItems(row, versionId, plan.newItems, defaultBranchName, defaultBranchName)
                          )
                      )
                    : [];
            assertBindingSnapshotLimits(activeFiles, plan.retiredFileIds, changedItems);

            if (changedItems.length > 0) {
                const created = await step.run({ name: "commit-external-files" }, async () =>
                    runWorkerEffect(insertConnectorFiles(row, changedItems, versionId, input.cursor))
                );
                await runWorkerEffect(
                    runProcessFilesWithCleanup(
                        step,
                        row.binding.graphId,
                        created,
                        repositoryProcessOptions(changedItems, plan.retiredFileIds)
                    )
                );
                const fastBranchFileCount = await indexFastBranchFileCount();
                await step.run({ name: "mark-binding-synced" }, async () =>
                    runWorkerEffect(markBindingSynced(row.binding.id, versionId, input.cursor))
                );
                return { versionId, fileCount: created.fileIds.length + fastBranchFileCount };
            }

            await step.runWorkflow(processFilesSpec, {
                graphId: row.binding.graphId,
                fileIds: [],
                code: { kind: "repository", retiredFileIds: plan.retiredFileIds },
            });
            const fastBranchFileCount = await indexFastBranchFileCount();
            await step.run({ name: "mark-binding-synced" }, async () =>
                runWorkerEffect(markBindingSynced(row.binding.id, versionId, input.cursor))
            );
            return { versionId, fileCount: fastBranchFileCount };
        } catch (error) {
            if (run.retryTerminal) {
                await step.run({ name: "mark-binding-failed", retryPolicy: NO_RETRY }, async () =>
                    runWorkerEffect(markBindingFailed(input.bindingId))
                );
            }

            throw error;
        }
    }
);
