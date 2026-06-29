import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { ConnectorResourceChange, ProviderCodeFile } from "@kiwi/connectors";

type SelectResult = { kind: "limit"; value: unknown[] } | { kind: "where"; value: unknown[] };

const insertedFileValues: Array<Record<string, unknown>> = [];
const processWorkflowInputs: Array<Record<string, unknown>> = [];
const deleteWorkflowInputs: Array<Record<string, unknown>> = [];
const bindingUpdates: Array<Record<string, unknown>> = [];
const compareCalls: Array<{ fromVersionId: string; toVersionId: string }> = [];
const readFileCalls: Array<{ path: string; versionId: string | undefined }> = [];
const txWhereConditions: unknown[] = [];
const updateWhereConditions: unknown[] = [];
const pendingReadResolutions: Array<() => void> = [];
const readStartWaiters: Array<{ count: number; resolve: () => void }> = [];

const uploadedNamedFiles: Array<{ name: string; file: unknown; path: string; bucket: string }> = [];
let selectResults: SelectResult[] = [];
let txSelectResults: unknown[][] = [];
let insertedFileRowsOverride: Array<{ id: string; key: string }> | null = null;
let processRunInsertCount = 0;
let processFilesError: Error | null = null;
let compareChanges: Array<ConnectorResourceChange & Record<string, unknown>> = [];
let compareIsIncremental = true;
let snapshotFiles: Array<ProviderCodeFile & Record<string, unknown>> = [];
let readFileContents: Record<string, string> = {};
let adapterProvider = "github";
let adapterResourceKind = "git-repository";
let adapterCapabilities = { versions: true, cursorSync: false, children: false, binaryFiles: false };
let listChangesResult: {
    changes: Array<ConnectorResourceChange & Record<string, unknown>>;
    cursor: string;
    versionId?: string;
    isInitial: boolean;
} | null = null;
const listChangesCalls: Array<{ resourceId: string; cursor: string | undefined }> = [];
const openFileCalls: Array<{
    resourceId: string;
    path: string;
    versionId?: string;
    etag?: string;
    resourceKind?: string;
}> = [];
const openFileContents: Record<string, { bytes: Uint8Array; size: number; contentType?: string }> = {};
let loadSnapshotCalls = 0;
let activeReadFileCalls = 0;
let holdReadFiles = false;
let maxReadFileConcurrency = 0;
let readStartedCount = 0;
let readFileDelayMs = 0;

function createSelectQuery() {
    const result = selectResults.shift();
    if (!result) {
        throw new Error("Unexpected select call");
    }

    const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => (result.kind === "where" ? result.value : chain),
        limit: () => (result.kind === "limit" ? result.value : result.value),
    };
    return chain;
}

function createTxSelectQuery() {
    const result = txSelectResults.shift();
    if (!result) {
        throw new Error("Unexpected transaction select call");
    }

    const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: (condition: unknown) => {
            txWhereConditions.push(condition);
            return Effect.succeed(result);
        },
        limit: () => Effect.succeed(result),
    };
    return chain;
}

function queryContainsParamValue(value: unknown, expected: unknown, seen = new WeakSet<object>()): boolean {
    if (Array.isArray(value)) {
        return value.some((item) => queryContainsParamValue(item, expected, seen));
    }
    if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
            return false;
        }
        seen.add(value);
        if (value.constructor.name === "Param" && "value" in value) {
            return value.value === expected;
        }
        return Object.values(value).some((item) => queryContainsParamValue(item, expected, seen));
    }
    return false;
}

function notifyReadStarted() {
    readStartedCount += 1;
    for (let index = readStartWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = readStartWaiters[index];
        if (waiter && readStartedCount >= waiter.count) {
            readStartWaiters.splice(index, 1);
            waiter.resolve();
        }
    }
}

const transactionDb = {
    select: () => createTxSelectQuery(),
    update: () => ({
        set: (values: Record<string, unknown>) => ({
            where: () =>
                Effect.sync(() => {
                    bindingUpdates.push(values);
                    return undefined;
                }),
        }),
    }),
    insert: () => ({
        values: (values: unknown) => {
            if (
                Array.isArray(values) &&
                values.every(
                    (value) =>
                        typeof value === "object" && value !== null && "processRunId" in value && "fileId" in value
                )
            ) {
                return Effect.succeed(undefined);
            }

            return {
                onConflictDoNothing: () => ({
                    returning: () =>
                        Effect.sync(() => {
                            if (!Array.isArray(values)) {
                                throw new Error("Expected file rows");
                            }
                            insertedFileValues.push(...(values as Array<Record<string, unknown>>));
                            return (
                                insertedFileRowsOverride ??
                                (values as Array<{ id: string; key: string }>).map((value) => ({
                                    id: value.id,
                                    key: value.key,
                                }))
                            );
                        }),
                }),
                returning: () =>
                    Effect.sync(() => {
                        processRunInsertCount += 1;
                        return [{ id: "process-run-1" }];
                    }),
            };
        },
    }),
};

function runTransactionResult<T>(result: T | PromiseLike<T> | Effect.Effect<T>) {
    return Effect.isEffect(result) ? Effect.runPromise(result) : result;
}

const mockDb = {
    select: () => createSelectQuery(),
    update: () => ({
        set: (values: Record<string, unknown>) => ({
            where: async (condition: unknown) => {
                bindingUpdates.push(values);
                updateWhereConditions.push(condition);
                return undefined;
            },
        }),
    }),
    transaction: <T>(callback: (tx: typeof transactionDb) => T | PromiseLike<T> | Effect.Effect<T>) =>
        runTransactionResult(callback(transactionDb)),
};

function runMockDbEffect(thunk: (db: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(mockDb);
    return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
}

mock.module("../../runtime/effect", () => ({
    withWorkerDb: runMockDbEffect,
    withWorkerDbVoid: (thunk: (db: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown>) =>
        Effect.asVoid(runMockDbEffect(thunk)),
    runWorkerEffect: <T, E>(effect: Effect.Effect<T, E>) => Effect.runPromise(effect),
}));

mock.module("@kiwi/connectors", () => ({
    ConnectorProviderError: class ConnectorProviderError extends Error {
        constructor(
            public readonly kind: string,
            message: string
        ) {
            super(message);
            this.name = "ConnectorProviderError";
        }
    },
    MAX_REPOSITORY_CODE_BYTES: 100_000,
    MAX_REPOSITORY_CODE_FILES: 100,
    createConnectorAdapter: () =>
        Effect.succeed({
            provider: adapterProvider,
            resourceKind: adapterResourceKind,
            capabilities: adapterCapabilities,
            getResource: () =>
                Effect.succeed({
                    provider: "github",
                    kind: "git-repository",
                    id: "1",
                    displayName: "acme/widgets",
                    webUrl: "https://github.com/acme/widgets",
                    private: true,
                }),
            listResources: () => Effect.succeed([]),
            listResourceVersions: () => Effect.succeed([{ resourceId: "1", name: "main", versionId: "commit-new" }]),
            loadSnapshot: () =>
                Effect.sync(() => {
                    loadSnapshotCalls += 1;
                    return {
                        resource: {
                            provider: "github",
                            kind: "git-repository",
                            id: "1",
                            displayName: "acme/widgets",
                            webUrl: "https://github.com/acme/widgets",
                            private: true,
                        },
                        version: { resourceId: "1", name: "main", versionId: "commit-new" },
                        files: snapshotFiles,
                    };
                }),
            compareVersions: (_resourceId: string, fromVersionId: string, toVersionId: string) =>
                Effect.sync(() => {
                    compareCalls.push({ fromVersionId, toVersionId });
                    return { fromVersionId, toVersionId, isIncremental: compareIsIncremental, changes: compareChanges };
                }),
            readFile: (locator: { path: string; versionId?: string }) =>
                Effect.tryPromise({
                    try: async () => {
                        readFileCalls.push({ path: locator.path, versionId: locator.versionId });
                        activeReadFileCalls += 1;
                        maxReadFileConcurrency = Math.max(maxReadFileConcurrency, activeReadFileCalls);
                        if (holdReadFiles) {
                            const { promise, resolve } = Promise.withResolvers<void>();
                            pendingReadResolutions.push(resolve);
                            notifyReadStarted();
                            await promise;
                        } else {
                            notifyReadStarted();
                            if (readFileDelayMs > 0) {
                                await new Promise((resolve) => setTimeout(resolve, readFileDelayMs));
                            }
                        }
                        activeReadFileCalls -= 1;
                        const content = readFileContents[locator.path];
                        if (!content) {
                            throw new Error(`Missing mocked content for ${locator.path}`);
                        }
                        return content;
                    },
                    catch: (error) => error,
                }),
            listChanges: (resourceId: string, cursor?: string) =>
                Effect.sync(() => {
                    listChangesCalls.push({ resourceId, cursor });
                    if (!listChangesResult) {
                        throw new Error("Missing mocked listChanges result");
                    }
                    return listChangesResult;
                }),
            openFile: (locator: {
                resourceId: string;
                path: string;
                versionId?: string;
                etag?: string;
                resourceKind?: string;
            }) =>
                Effect.sync(() => {
                    openFileCalls.push(locator);
                    const file = openFileContents[locator.path];
                    if (!file) {
                        throw new Error(`Missing mocked binary content for ${locator.path}`);
                    }
                    return { locator, ...file };
                }),
        }),
    isKnownConnectorProvider: () => true,
    normalizeGitLabBaseUrl: (value: string) => value.replace(/\/+$/, ""),
}));

mock.module("@kiwi/connectors/credentials", () => ({
    decryptConnectorCredentials: () => ({ provider: "github", appId: "app-1", privateKeyPem: "pem" }),
    isConnectorCredentialsForProvider: () => true,
    isInstallationCredentialsForProvider: () => true,
}));

mock.module("../../../env", () => ({
    env: {
        AUTH_SECRET: "test-secret",
    },
}));

mock.module("@kiwi/files", () => ({
    putNamedFile: (name: string, file: unknown, path: string, bucket: string) =>
        Effect.sync(() => {
            uploadedNamedFiles.push({ name, file, path, bucket });
            return { key: `${path}/${name}`, type: "application/octet-stream" };
        }),
}));

function bindingRow(
    lastSyncedVersionId: string | null,
    overrides: {
        binding?: Record<string, unknown>;
        installation?: Record<string, unknown>;
        connector?: Record<string, unknown>;
        graph?: Record<string, unknown>;
    } = {}
) {
    return {
        binding: {
            id: "binding-1",
            graphId: "graph-1",
            connectorInstallationId: "installation-1",
            providerResourceId: "1",
            resourceKind: "git-repository",
            resourceDisplayName: "acme/widgets",
            resourceWebUrl: "https://github.com/acme/widgets",
            versionName: "main",
            webhookEnabled: true,
            syncEnabled: true,
            syncCursor: null,
            lastSeenVersionId: lastSyncedVersionId,
            lastSyncedVersionId,
            ...overrides.binding,
        },
        installation: {
            id: "installation-1",
            connectorId: "connector-1",
            providerInstallationId: "99",
            encryptedCredentials: null,
            status: "active",
            ...overrides.installation,
        },
        connector: {
            id: "connector-1",
            provider: "github",
            encryptedCredentials: "encrypted",
            status: "active",
            ...overrides.connector,
        },
        graph: {
            id: "graph-1",
            state: "ready",
            ...overrides.graph,
        },
    };
}

function activeFile(
    id: string,
    versionId: string,
    path: string,
    size: number,
    metadataOverrides: Record<string, unknown> = {}
) {
    return {
        id,
        size,
        metadata: JSON.stringify({
            schemaVersion: 2,
            provider: "github",
            bindingId: "binding-1",
            resourceKind: "git-repository",
            providerResourceId: "1",
            resourceDisplayName: "acme/widgets",
            path,
            displayName: path.split("/").at(-1) ?? path,
            versionId,
            git: {
                repositoryName: "acme/widgets",
                repositoryUrl: "https://github.com/acme/widgets",
                commitSha: versionId,
                branch: "main",
            },
            ...metadataOverrides,
        }),
    };
}

function useFakeStorageAdapter() {
    adapterProvider = "fixture-storage";
    adapterResourceKind = "folder";
    adapterCapabilities = { versions: false, cursorSync: true, children: true, binaryFiles: true };
}

function fakeStorageBinding(lastSyncedVersionId: string | null) {
    return bindingRow(lastSyncedVersionId, {
        binding: {
            providerResourceId: "drive-1",
            resourceKind: "folder",
            resourceDisplayName: "Team Drive",
            resourceWebUrl: "https://storage.test/team-drive",
            versionName: null,
            syncCursor: lastSyncedVersionId,
            webhookEnabled: false,
            syncEnabled: true,
        },
        connector: { provider: "fixture-storage" },
        installation: { encryptedCredentials: "encrypted-installation" },
    });
}

function fakeStorageFileBinding(lastSyncedVersionId: string | null) {
    return bindingRow(lastSyncedVersionId, {
        binding: {
            providerResourceId: "Team/Docs/manual.pdf",
            resourceKind: "file",
            resourceDisplayName: "manual.pdf",
            resourceWebUrl: "https://storage.test/team-drive/Docs/manual.pdf",
            versionName: null,
            syncCursor: lastSyncedVersionId,
            webhookEnabled: false,
            syncEnabled: true,
        },
        connector: { provider: "fixture-storage" },
        installation: { encryptedCredentials: "encrypted-installation" },
    });
}

async function runWorkflow(input: {
    bindingId: string;
    reason: "manual" | "webhook" | "initial";
    versionId?: string;
    cursor?: string;
    deliveryId?: string;
}) {
    return syncConnectorResourceGraph.fn({
        input,
        step: {
            run: async (_config: { name: string }, fn: () => unknown) => {
                const result = await fn();
                return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
            },
            runWorkflow: async (spec: { name: string }, workflowInput?: unknown) => {
                if (spec.name === "process-files") {
                    processWorkflowInputs.push((workflowInput ?? {}) as Record<string, unknown>);
                    if (processFilesError) {
                        throw processFilesError;
                    }
                    return undefined;
                }
                if (spec.name === "delete-file") {
                    deleteWorkflowInputs.push((workflowInput ?? {}) as Record<string, unknown>);
                    return undefined;
                }
                throw new Error(`Unexpected workflow ${spec.name}`);
            },
        } as never,
        version: null,
        run: {
            id: "workflow-run-1",
            workflowName: "sync-connector-resource-graph",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            startedAt: new Date("2026-01-01T00:00:00Z"),
            retryAttempt: 1,
            retryMaxAttempts: 1,
            retryTerminal: true,
        },
    });
}

// Test exception: static import cannot work because Bun module mocks must be registered before evaluating the workflow module.
const { syncConnectorResourceGraph } = await import("../../../workflows/sync-connector-resource-graph");

describe("syncConnectorResourceGraph", () => {
    beforeEach(() => {
        insertedFileValues.length = 0;
        processWorkflowInputs.length = 0;
        deleteWorkflowInputs.length = 0;
        bindingUpdates.length = 0;
        compareCalls.length = 0;
        readFileCalls.length = 0;
        txWhereConditions.length = 0;
        updateWhereConditions.length = 0;
        pendingReadResolutions.length = 0;
        readStartWaiters.length = 0;
        selectResults = [];
        processFilesError = null;
        compareChanges = [];
        compareIsIncremental = true;
        snapshotFiles = [];
        readFileContents = {};
        adapterProvider = "github";
        adapterResourceKind = "git-repository";
        adapterCapabilities = { versions: true, cursorSync: false, children: false, binaryFiles: false };
        listChangesResult = null;
        listChangesCalls.length = 0;
        openFileCalls.length = 0;
        uploadedNamedFiles.length = 0;
        for (const key of Object.keys(openFileContents)) {
            delete openFileContents[key];
        }
        loadSnapshotCalls = 0;
        activeReadFileCalls = 0;
        holdReadFiles = false;
        maxReadFileConcurrency = 0;
        readStartedCount = 0;
        readFileDelayMs = 0;
        txSelectResults = [];
        insertedFileRowsOverride = null;
        processRunInsertCount = 0;
    });

    test("processes only changed supported connector files", async () => {
        compareChanges = [{ status: "modified", newPath: "src/index.ts" }];
        readFileContents = {
            "src/index.ts": "export const next = shared;\n",
        };
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [
                    activeFile("old-file", "commit-old", "src/index.ts", 25),
                    activeFile("shared-file", "commit-old", "src/shared.ts", 22),
                ],
            },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 1 });
        expect(loadSnapshotCalls).toBe(0);
        expect(compareCalls).toEqual([{ fromVersionId: "commit-old", toVersionId: "commit-new" }]);
        expect(readFileCalls).toEqual([{ path: "src/index.ts", versionId: "commit-new" }]);
        expect(insertedFileValues.map((row) => row.name)).toEqual(["src/index.ts"]);
        expect(processWorkflowInputs).toHaveLength(1);
        expect(processWorkflowInputs[0]).toMatchObject({
            graphId: "graph-1",
            processRunId: "process-run-1",
            code: { kind: "repository", retiredFileIds: ["old-file"] },
        });
        expect(String(insertedFileValues[0]?.checksum)).toStartWith("commit-new:src/index.ts:");
    });

    test("manual sync runs when webhooks are disabled but sync is enabled", async () => {
        compareChanges = [{ status: "modified", newPath: "src/index.ts" }];
        readFileContents = {
            "src/index.ts": "export const manual = true;\n",
        };
        selectResults = [
            {
                kind: "limit",
                value: [bindingRow("commit-old", { binding: { webhookEnabled: false, syncEnabled: true } })],
            },
            {
                kind: "where",
                value: [activeFile("old-file", "commit-old", "src/index.ts", 25)],
            },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 1 });
        expect(readFileCalls).toEqual([{ path: "src/index.ts", versionId: "commit-new" }]);
        expect(processWorkflowInputs).toHaveLength(1);
        expect(bindingUpdates).toContainEqual({
            syncStatus: "synced",
            lastSeenVersionId: "commit-new",
            lastSyncedVersionId: "commit-new",
            syncErrorCode: null,
        });
    });

    test("folder providers retire renamed and deleted items by provider item id", async () => {
        useFakeStorageAdapter();
        listChangesResult = {
            cursor: "cursor-next",
            isInitial: false,
            changes: [
                {
                    status: "renamed",
                    providerItemId: "file-report",
                    oldProviderItemId: "file-report",
                    newPath: "Renamed/report.txt",
                    displayName: "report.txt",
                    contentAccessMode: "text",
                    processingKind: "code",
                },
                {
                    status: "deleted",
                    providerItemId: "file-removed",
                },
            ] as Array<ConnectorResourceChange & Record<string, unknown>>,
        };
        readFileContents = {
            "Renamed/report.txt": "renamed report\n",
        };
        selectResults = [
            { kind: "limit", value: [fakeStorageBinding("cursor-old")] },
            {
                kind: "where",
                value: [
                    activeFile("old-report", "etag-old", "Archive/report.txt", 15, {
                        providerFileId: "file-report",
                        resourceKind: "folder",
                        git: undefined,
                    }),
                    activeFile("old-removed", "etag-removed", "Archive/removed.txt", 10, {
                        providerFileId: "file-removed",
                        resourceKind: "folder",
                        git: undefined,
                    }),
                ],
            },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual" });

        expect(result).toMatchObject({ versionId: "cursor-next", fileCount: 1 });
        expect(listChangesCalls).toEqual([{ resourceId: "drive-1", cursor: "cursor-old" }]);
        expect(readFileCalls).toEqual([{ path: "Renamed/report.txt", versionId: "cursor-next" }]);
        expect(insertedFileValues[0]?.key).toContain("file-report");
        expect(JSON.parse(String(insertedFileValues[0]?.metadata))).toMatchObject({
            resourceKind: "folder",
            providerResourceId: "drive-1",
            providerFileId: "file-report",
            path: "Renamed/report.txt",
        });
        expect(processWorkflowInputs[0]).toMatchObject({
            code: { kind: "repository", retiredFileIds: ["old-report", "old-removed"] },
        });
    });

    test("binary document cursor items upload and process through the file pipeline", async () => {
        useFakeStorageAdapter();
        openFileContents["Documents/report.pdf"] = {
            bytes: new Uint8Array([37, 80, 68, 70]),
            size: 4,
            contentType: "application/pdf",
        };
        listChangesResult = {
            cursor: "cursor-next",
            versionId: "version-next",
            isInitial: false,
            changes: [
                {
                    status: "modified",
                    providerItemId: "pdf-1",
                    parentProviderItemId: "folder-1",
                    newPath: "Documents/report.pdf",
                    displayName: "report.pdf",
                    mimeType: "application/pdf",
                    contentType: "application/pdf",
                    size: 42,
                    checksum: "etag-pdf",
                    etag: "etag-pdf",
                    webUrl: "https://storage.test/team-drive/Documents/report.pdf",
                    contentAccessMode: "binary",
                    processingKind: "document",
                },
            ] as Array<ConnectorResourceChange & Record<string, unknown>>,
        };
        selectResults = [
            { kind: "limit", value: [fakeStorageBinding("cursor-old")] },
            { kind: "where", value: [] },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual" });

        expect(result).toMatchObject({ versionId: "version-next", fileCount: 1 });
        expect(listChangesCalls).toEqual([{ resourceId: "drive-1", cursor: "cursor-old" }]);
        expect(openFileCalls).toEqual([
            {
                resourceId: "drive-1",
                path: "Documents/report.pdf",
                versionId: "version-next",
                etag: "etag-pdf",
                resourceKind: "folder",
            },
        ]);
        expect(uploadedNamedFiles).toMatchObject([
            {
                name: "report.pdf",
                path: "graphs/graph-1/connector-resources/binding-1/version-next",
            },
        ]);
        expect(insertedFileValues[0]).toMatchObject({
            name: "Documents/report.pdf",
            type: "pdf",
            mimeType: "application/pdf",
            storageKind: "external",
            externalUrl: "https://storage.test/team-drive/Documents/report.pdf",
            externalProvider: "fixture-storage",
            connectorBindingId: "binding-1",
            checksum: "version-next:pdf-1:etag-pdf",
        });
        expect(processWorkflowInputs).toHaveLength(1);
        expect(processWorkflowInputs[0]).toMatchObject({
            graphId: "graph-1",
            fileIds: [insertedFileValues[0]?.id],
            processRunId: "process-run-1",
        });
        expect(processWorkflowInputs[0]).not.toHaveProperty("code");
        expect(bindingUpdates).toContainEqual({
            syncStatus: "synced",
            lastSeenVersionId: "version-next",
            lastSyncedVersionId: "version-next",
            syncErrorCode: null,
            syncCursor: "cursor-next",
        });
    });

    test("single file cursor resources open the selected file path directly", async () => {
        useFakeStorageAdapter();
        openFileContents["manual.pdf"] = {
            bytes: new Uint8Array([37, 80, 68, 70]),
            size: 4,
            contentType: "application/pdf",
        };
        listChangesResult = {
            cursor: "cursor-next",
            versionId: "version-next",
            isInitial: true,
            changes: [
                {
                    status: "added",
                    providerItemId: "file-manual",
                    newPath: "manual.pdf",
                    displayName: "manual.pdf",
                    mimeType: "application/pdf",
                    contentType: "application/pdf",
                    size: 4,
                    checksum: "etag-manual",
                    etag: "etag-manual",
                    webUrl: "https://storage.test/team-drive/Docs/manual.pdf",
                    contentAccessMode: "binary",
                    processingKind: "document",
                },
            ] as Array<ConnectorResourceChange & Record<string, unknown>>,
        };
        selectResults = [
            { kind: "limit", value: [fakeStorageFileBinding(null)] },
            { kind: "where", value: [] },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual" });

        expect(result).toMatchObject({ versionId: "version-next", fileCount: 1 });
        expect(listChangesCalls).toEqual([{ resourceId: "Team/Docs/manual.pdf", cursor: undefined }]);
        expect(openFileCalls).toEqual([
            {
                resourceId: "Team/Docs/manual.pdf",
                path: "manual.pdf",
                versionId: "version-next",
                etag: "etag-manual",
                resourceKind: "file",
            },
        ]);
        expect(insertedFileValues[0]).toMatchObject({
            name: "manual.pdf",
            type: "pdf",
            mimeType: "application/pdf",
            storageKind: "external",
            externalUrl: "https://storage.test/team-drive/Docs/manual.pdf",
            externalProvider: "fixture-storage",
            connectorBindingId: "binding-1",
            checksum: "version-next:file-manual:etag-manual",
        });
        expect(processWorkflowInputs).toHaveLength(1);
    });

    test("limits concurrent provider reads for incremental changed files", async () => {
        const changedPaths = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`);
        compareChanges = changedPaths.map((newPath) => ({ status: "modified", newPath }));
        readFileContents = Object.fromEntries(changedPaths.map((path) => [path, `export const value = "${path}";\n`]));
        readFileDelayMs = 5;
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: changedPaths.map((path, index) => activeFile(`old-file-${index}`, "commit-old", path, 25)),
            },
        ];

        const result = await runWorkflow({
            bindingId: "binding-1",
            reason: "manual",
            versionId: "commit-new",
        });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 10 });
        expect(maxReadFileConcurrency).toBeLessThanOrEqual(4);
        expect(maxReadFileConcurrency).toBeGreaterThan(1);
    });

    test("reuses existing repository files and process run when file insert conflicts", async () => {
        compareChanges = [{ status: "modified", newPath: "src/index.ts" }];
        readFileContents = {
            "src/index.ts": "export const next = shared;\n",
        };
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [activeFile("old-file", "commit-old", "src/index.ts", 25)],
            },
        ];
        insertedFileRowsOverride = [];
        txSelectResults = [
            [{ id: "existing-file", key: "connector:binding-1:commit-new:src/index.ts" }],
            [{ id: "existing-process-run", status: "pending", fileId: "existing-file" }],
            [{ processRunId: "existing-process-run", fileId: "existing-file" }],
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 1 });
        expect(processRunInsertCount).toBe(0);
        expect(processWorkflowInputs).toEqual([
            {
                graphId: "graph-1",
                fileIds: ["existing-file"],
                processRunId: "existing-process-run",
                code: { kind: "repository", retiredFileIds: ["old-file"] },
            },
        ]);
    });

    test("skips processing when file insert conflicts with a completed process run", async () => {
        compareChanges = [{ status: "modified", newPath: "src/index.ts" }];
        readFileContents = {
            "src/index.ts": "export const next = shared;\n",
        };
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [activeFile("old-file", "commit-old", "src/index.ts", 25)],
            },
        ];
        insertedFileRowsOverride = [];
        txSelectResults = [
            [{ id: "existing-file", key: "connector:binding-1:commit-new:src/index.ts" }],
            [{ id: "completed-process-run", status: "completed", fileId: "existing-file" }],
            [{ processRunId: "completed-process-run", fileId: "existing-file" }],
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 1 });
        expect(processRunInsertCount).toBe(0);
        expect(queryContainsParamValue(txWhereConditions[1], "completed")).toBe(true);
        expect(processWorkflowInputs).toEqual([]);
        expect(bindingUpdates).toContainEqual({
            syncStatus: "synced",
            lastSeenVersionId: "commit-new",
            lastSyncedVersionId: "commit-new",
            syncErrorCode: null,
        });
    });

    test("creates a process run when matching run has extra files", async () => {
        compareChanges = [{ status: "modified", newPath: "src/index.ts" }];
        readFileContents = {
            "src/index.ts": "export const next = shared;\n",
        };
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [activeFile("old-file", "commit-old", "src/index.ts", 25)],
            },
        ];
        insertedFileRowsOverride = [];
        txSelectResults = [
            [{ id: "existing-file", key: "connector:binding-1:commit-new:src/index.ts" }],
            [{ id: "larger-process-run", status: "completed", fileId: "existing-file" }],
            [
                { processRunId: "larger-process-run", fileId: "existing-file" },
                { processRunId: "larger-process-run", fileId: "other-file" },
            ],
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 1 });
        expect(processRunInsertCount).toBe(1);
        expect(processWorkflowInputs).toEqual([
            {
                graphId: "graph-1",
                fileIds: ["existing-file"],
                processRunId: "process-run-1",
                code: { kind: "repository", retiredFileIds: ["old-file"] },
            },
        ]);
    });

    test("finalizes delete-only connector deltas without inserting new files", async () => {
        compareChanges = [{ status: "deleted", oldPath: "src/removed.ts" }];
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [
                    activeFile("removed-file", "commit-old", "src/removed.ts", 20),
                    activeFile("shared-file", "commit-old", "src/shared.ts", 22),
                ],
            },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 0 });
        expect(readFileCalls).toEqual([]);
        expect(insertedFileValues).toEqual([]);
        expect(processWorkflowInputs).toEqual([
            {
                graphId: "graph-1",
                fileIds: [],
                code: { kind: "repository", retiredFileIds: ["removed-file"] },
            },
        ]);
    });

    test("skips processing when no supported code paths changed", async () => {
        compareChanges = [];
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [activeFile("old-file", "commit-old", "src/index.ts", 25)],
            },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 0 });
        expect(processWorkflowInputs).toEqual([]);
        expect(insertedFileValues).toEqual([]);
        expect(bindingUpdates).toContainEqual({
            syncStatus: "synced",
            lastSeenVersionId: "commit-new",
            lastSyncedVersionId: "commit-new",
            syncErrorCode: null,
        });
    });

    test("scopes duplicate webhook markers to the connector", async () => {
        selectResults = [{ kind: "limit", value: [bindingRow("commit-new")] }];

        const result = await runWorkflow({
            bindingId: "binding-1",
            reason: "webhook",
            versionId: "commit-new",
            deliveryId: "delivery-1",
        });

        expect(result).toEqual({ skipped: true, versionId: "commit-new" });
        expect(bindingUpdates).toContainEqual({ status: "duplicate" });
        expect(queryContainsParamValue(updateWhereConditions.at(-1), "connector-1")).toBe(true);
        expect(queryContainsParamValue(updateWhereConditions.at(-1), "github")).toBe(true);
        expect(queryContainsParamValue(updateWhereConditions.at(-1), "delivery-1")).toBe(true);
    });

    test("falls back to a full snapshot when compare is not incremental", async () => {
        compareIsIncremental = false;
        snapshotFiles = [
            {
                path: "src/reset.ts",
                size: 24,
                checksum: "reset-sha",
                htmlUrl: "https://github.com/acme/widgets/blob/commit-new/src/reset.ts",
                rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-new/src/reset.ts",
                content: "export const reset = true;\n",
            },
        ];
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [
                    activeFile("old-file", "commit-old", "src/index.ts", 25),
                    activeFile("shared-file", "commit-old", "src/shared.ts", 22),
                ],
            },
        ];

        const result = await runWorkflow({ bindingId: "binding-1", reason: "webhook", versionId: "commit-new" });

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 1 });
        expect(loadSnapshotCalls).toBe(1);
        expect(readFileCalls).toEqual([]);
        expect(insertedFileValues.map((row) => row.name)).toEqual(["src/reset.ts"]);
        expect(insertedFileValues[0]?.externalUrl).toBe("https://github.com/acme/widgets/blob/commit-new/src/reset.ts");
        expect(processWorkflowInputs[0]).toMatchObject({
            graphId: "graph-1",
            processRunId: "process-run-1",
            code: { kind: "repository", retiredFileIds: ["old-file", "shared-file"] },
        });
    });

    test("rolls back inserted files when incremental processing fails", async () => {
        compareChanges = [{ status: "modified", newPath: "src/index.ts" }];
        readFileContents = {
            "src/index.ts": "export const next = shared;\n",
        };
        processFilesError = new Error("child failure");
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [
                    activeFile("old-file", "commit-old", "src/index.ts", 25),
                    activeFile("shared-file", "commit-old", "src/shared.ts", 22),
                ],
            },
        ];

        await expect(
            runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" })
        ).rejects.toThrow("child failure");
        expect(deleteWorkflowInputs).toEqual([{ graphId: "graph-1", fileId: insertedFileValues[0]?.id }]);
    });

    test("marks binding failed when terminal processing fails", async () => {
        compareChanges = [{ status: "modified", newPath: "src/index.ts" }];
        readFileContents = {
            "src/index.ts": "export const next = shared;\n",
        };
        processFilesError = new Error("child failure");
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: [
                    activeFile("old-file", "commit-old", "src/index.ts", 25),
                    activeFile("shared-file", "commit-old", "src/shared.ts", 22),
                ],
            },
        ];

        await expect(
            runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" })
        ).rejects.toThrow("child failure");
        expect(bindingUpdates).toContainEqual({
            syncStatus: "failed",
            syncErrorCode: "sync_failed",
        });
    });

    test("rejects duplicate normalized paths from provider deltas", async () => {
        compareChanges = [
            { status: "modified", newPath: "src/index.ts" },
            { status: "deleted", oldPath: "src/index.ts" },
        ];
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            { kind: "where", value: [activeFile("old-file", "commit-old", "src/index.ts", 25)] },
        ];

        await expect(
            runWorkflow({ bindingId: "binding-1", reason: "manual", versionId: "commit-new" })
        ).rejects.toThrow("Provider delta contained duplicate path src/index.ts");
        expect(processWorkflowInputs).toEqual([]);
    });
});
