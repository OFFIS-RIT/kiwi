import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConnectorResourceChange, ProviderCodeFile } from "@kiwi/connectors";

type SelectResult = { kind: "limit"; value: unknown[] } | { kind: "where"; value: unknown[] };

const insertedFileValues: Array<Record<string, unknown>> = [];
const processWorkflowInputs: Array<Record<string, unknown>> = [];
const deleteWorkflowInputs: Array<Record<string, unknown>> = [];
const bindingUpdates: Array<Record<string, unknown>> = [];
const compareCalls: Array<{ fromVersionId: string; toVersionId: string }> = [];
const readFileCalls: Array<{ path: string; versionId: string | undefined }> = [];
const txWhereConditions: unknown[] = [];
const pendingReadResolutions: Array<() => void> = [];
const readStartWaiters: Array<{ count: number; resolve: () => void }> = [];

let selectResults: SelectResult[] = [];
let txSelectResults: unknown[][] = [];
let insertedFileRowsOverride: Array<{ id: string; key: string }> | null = null;
let processRunInsertCount = 0;
let processFilesError: Error | null = null;
let compareChanges: ConnectorResourceChange[] = [];
let compareIsIncremental = true;
let snapshotFiles: ProviderCodeFile[] = [];
let readFileContents: Record<string, string> = {};
let loadSnapshotCalls = 0;
let activeReadFileCalls = 0;
let holdReadFiles = false;
let maxReadFileConcurrency = 0;
let readStartedCount = 0;

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
            return result;
        },
        limit: () => result,
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

function waitForReadStarts(count: number): Promise<void> {
    if (readStartedCount >= count) {
        return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    readStartWaiters.push({ count, resolve });
    return promise;
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
            where: async () => {
                bindingUpdates.push(values);
                return undefined;
            },
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
                return undefined;
            }

            return {
                onConflictDoNothing: () => ({
                    returning: () => {
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
                    },
                }),
                returning: () => {
                    processRunInsertCount += 1;
                    return [{ id: "process-run-1" }];
                },
            };
        },
    }),
};

mock.module("@kiwi/db", () => ({
    db: {
        select: () => createSelectQuery(),
        update: () => ({
            set: (values: Record<string, unknown>) => ({
                where: async () => {
                    bindingUpdates.push(values);
                    return undefined;
                },
            }),
        }),
        transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
    },
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
    createConnectorAdapter: async () => ({
        provider: "github",
        resourceKind: "git-repository",
        getResource: async () => ({
            provider: "github",
            kind: "git-repository",
            id: "1",
            displayName: "acme/widgets",
            webUrl: "https://github.com/acme/widgets",
            private: true,
        }),
        listResources: async () => [],
        listResourceVersions: async () => [{ resourceId: "1", name: "main", versionId: "commit-new" }],
        loadSnapshot: async () => {
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
        },
        compareVersions: async (_resourceId: string, fromVersionId: string, toVersionId: string) => {
            compareCalls.push({ fromVersionId, toVersionId });
            return { fromVersionId, toVersionId, isIncremental: compareIsIncremental, changes: compareChanges };
        },
        readFile: async (locator: { path: string; versionId?: string }) => {
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
            }
            activeReadFileCalls -= 1;
            const content = readFileContents[locator.path];
            if (!content) {
                throw new Error(`Missing mocked content for ${locator.path}`);
            }
            return content;
        },
    }),
    normalizeGitLabBaseUrl: (value: string) => value.replace(/\/+$/, ""),
}));

mock.module("@kiwi/connectors/credentials", () => ({
    decryptConnectorCredentials: () => ({ provider: "github", appId: "app-1", privateKeyPem: "pem" }),
}));

mock.module("../env", () => ({
    env: {
        AUTH_SECRET: "test-secret",
    },
}));

function bindingRow(lastSyncedVersionId: string | null) {
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
            lastSeenVersionId: lastSyncedVersionId,
            lastSyncedVersionId,
        },
        installation: {
            id: "installation-1",
            connectorId: "connector-1",
            providerInstallationId: "99",
            encryptedCredentials: null,
            status: "active",
        },
        connector: {
            id: "connector-1",
            provider: "github",
            encryptedCredentials: "encrypted",
            status: "active",
        },
        graph: {
            id: "graph-1",
            state: "ready",
        },
    };
}

function activeFile(id: string, versionId: string, path: string, size: number) {
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
        }),
    };
}

async function runWorkflow(input: { bindingId: string; reason: "manual" | "webhook" | "initial"; versionId?: string }) {
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
const { syncConnectorResourceGraph } = await import("./sync-connector-resource-graph");

describe("syncConnectorResourceGraph", () => {
    beforeEach(() => {
        insertedFileValues.length = 0;
        processWorkflowInputs.length = 0;
        deleteWorkflowInputs.length = 0;
        bindingUpdates.length = 0;
        compareCalls.length = 0;
        readFileCalls.length = 0;
        txWhereConditions.length = 0;
        pendingReadResolutions.length = 0;
        readStartWaiters.length = 0;
        selectResults = [];
        processFilesError = null;
        compareChanges = [];
        compareIsIncremental = true;
        snapshotFiles = [];
        readFileContents = {};
        loadSnapshotCalls = 0;
        activeReadFileCalls = 0;
        holdReadFiles = false;
        maxReadFileConcurrency = 0;
        readStartedCount = 0;
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

    test("limits concurrent provider reads for incremental changed files", async () => {
        const changedPaths = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`);
        compareChanges = changedPaths.map((newPath) => ({ status: "modified", newPath }));
        readFileContents = Object.fromEntries(changedPaths.map((path) => [path, `export const value = "${path}";\n`]));
        holdReadFiles = true;
        selectResults = [
            { kind: "limit", value: [bindingRow("commit-old")] },
            {
                kind: "where",
                value: changedPaths.map((path, index) => activeFile(`old-file-${index}`, "commit-old", path, 25)),
            },
        ];

        const resultPromise = runWorkflow({
            bindingId: "binding-1",
            reason: "manual",
            versionId: "commit-new",
        });

        await waitForReadStarts(4);
        expect(maxReadFileConcurrency).toBeLessThanOrEqual(4);
        pendingReadResolutions.splice(0).forEach((resolve) => resolve());

        await waitForReadStarts(8);
        expect(maxReadFileConcurrency).toBeLessThanOrEqual(4);
        pendingReadResolutions.splice(0).forEach((resolve) => resolve());

        await waitForReadStarts(10);
        expect(maxReadFileConcurrency).toBeLessThanOrEqual(4);
        pendingReadResolutions.splice(0).forEach((resolve) => resolve());

        const result = await resultPromise;

        expect(result).toMatchObject({ versionId: "commit-new", fileCount: 10 });
        expect(maxReadFileConcurrency).toBeLessThanOrEqual(4);
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
