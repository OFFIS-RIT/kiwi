import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Elysia } from "elysia";

type Scenario =
    | "create-no-files"
    | "add-duplicate-files"
    | "delete-invalid-files"
    | "delete-files-success"
    | "delete-graph-warning";

const authUser = {
    id: "user-1",
    activeOrganizationId: "org-1",
    activeTeamId: null,
    isSystemAdmin: false,
};

const existingGraph = {
    id: "graph-1",
    name: "Existing graph",
    description: null,
    organizationId: "org-1",
    teamId: null,
    userId: null,
    graphId: null,
    hidden: false,
    state: "ready",
};

let scenario: Scenario = "create-no-files";
let dbSelectCount = 0;
let txSelectCount = 0;
const operationLog: string[] = [];
const uploadedFileNames: string[] = [];
const deletedS3Keys: string[] = [];
const listedPrefixes: string[] = [];

function queryRows(rows: unknown[]) {
    const chain = Object.assign(Effect.succeed(rows), {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        for: () => chain,
        then: <TResult1 = unknown[], TResult2 = never>(
            resolve?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
            reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) => Promise.resolve(rows).then(resolve, reject),
    });

    return chain;
}

function effectRows(rows: unknown[]) {
    return Object.assign(Effect.succeed(rows), {
        limit: () => Effect.succeed(rows),
    });
}

function effectWithReturning<T>(value: T, returningValue: unknown[]) {
    return Object.assign(Effect.succeed(value), {
        returning: () => Effect.succeed(returningValue),
    });
}

function runTransactionResult<T>(result: T | PromiseLike<T> | Effect.Effect<T>) {
    return Effect.isEffect(result) ? Effect.runPromise(result) : result;
}

function runMockDbEffect(thunk: (database: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(mockDb);
    if (Effect.isEffect(result)) {
        return result;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        return Effect.promise(async () => await result);
    }
    return Effect.succeed(result);
}

function nextDbRows() {
    dbSelectCount += 1;

    switch (scenario) {
        case "add-duplicate-files":
            return [{ checksum: "duplicate-checksum" }];
        case "delete-invalid-files":
        case "delete-files-success":
            return [{ id: "file-1", key: "graphs/graph-1/file-1.txt" }];
        default:
            return [];
    }
}

function nextTxRows() {
    txSelectCount += 1;

    if (scenario === "delete-graph-warning") {
        if (txSelectCount === 1) {
            return [{ id: "graph-1" }];
        }

        if (txSelectCount === 2) {
            return [{ id: "graph-2" }];
        }

        if (txSelectCount === 3) {
            return [];
        }

        if (txSelectCount === 4) {
            return [{ id: "file-1", graphId: "graph-1", key: "graphs/graph-1/file-1.txt" }];
        }
    }

    return [];
}

const transactionDb = {
    select: () => ({
        from: () => ({
            where: () => effectRows(nextTxRows()),
        }),
    }),
    update: () => ({
        set: (values: Record<string, unknown>) => ({
            where: () => {
                if (scenario === "delete-files-success") {
                    if (values.deleted === true) {
                        operationLog.push("files-marked-deleted");
                        return Effect.succeed(undefined);
                    }

                    if (values.state === "updating") {
                        operationLog.push("graph-state-updated");
                        return effectWithReturning(undefined, [
                            {
                                ...existingGraph,
                                state: "updating",
                            },
                        ]);
                    }
                }

                return effectWithReturning(undefined, []);
            },
        }),
    }),
    delete: () => ({
        where: () =>
            Effect.sync(() => {
                if (scenario === "delete-graph-warning") {
                    operationLog.push("graph-deleted");
                }
            }),
    }),
};

const mockDb = {
    insert: () => ({
        values: (values: Record<string, unknown>) => ({
            returning: () => [
                {
                    id: "graph-created",
                    name: values.name,
                    description: values.description ?? null,
                    organizationId: values.organizationId ?? null,
                    teamId: values.teamId ?? null,
                    userId: null,
                    graphId: values.graphId ?? null,
                    hidden: values.hidden,
                    state: values.state,
                },
            ],
        }),
    }),
    select: () => ({
        from: () => queryRows(nextDbRows()),
    }),
    transaction: async (callback: (tx: typeof transactionDb) => unknown) =>
        runTransactionResult(callback(transactionDb)),
};

mock.module("@kiwi/ai/models", () => ({
    AiModelRegistry: Effect.succeed({}),
    makeAiModelRegistryLayer: () => Layer.empty,
    getDefaultModelOrganizationId: () => Effect.succeed("org-1"),
}));

class MockDatabaseError extends Error {
    constructor(options?: { cause?: unknown }) {
        super("database error");
        this.cause = options?.cause;
    }
}

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed(mockDb),
    DatabaseError: MockDatabaseError,
    DatabaseLayer: Layer.empty,
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
    tryDb: runMockDbEffect,
    tryDbVoid: (thunk: (database: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) =>
        Effect.asVoid(runMockDbEffect(thunk)),
}));

mock.module("@kiwi/db", () => ({
    betterAuthDb: mockDb,
    db: mockDb,
}));

mock.module("../../env", () => ({
    env: {
        AUTH_SECRET: "secret",
        S3_BUCKET: "bucket",
    },
}));

mock.module("@kiwi/files", () => ({
    FileStorageLive: Layer.empty,
    deleteFile: (key: string) => {
        deletedS3Keys.push(key);
        return scenario === "delete-graph-warning" && key.endsWith("extra.txt")
            ? Effect.fail(new Error("delete failed"))
            : Effect.succeed(true);
    },
    listFiles: (prefix: string) => {
        listedPrefixes.push(prefix);
        return scenario === "delete-graph-warning" && prefix === "graphs/graph-2/"
            ? Effect.fail(new Error("list failed"))
            : Effect.succeed(prefix === "graphs/graph-1/" ? ["graphs/graph-1/extra.txt"] : []);
    },
    putGraphFile: (graphId: string, _fileId: string, name: string, file: File) => {
        uploadedFileNames.push(name);
        return Effect.succeed({
            key: `graphs/${graphId}/${name}`,
            type: file.type || "text/plain",
        });
    },
}));

mock.module("@kiwi/graph/code/metadata", () => ({
    serializeCodeFileMetadata: () => null,
}));

mock.module("@kiwi/logger", () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
}));

mock.module("@kiwi/worker/delete-graph-files-spec", () => ({
    deleteGraphFilesSpec: { name: "delete-graph-files" },
}));

mock.module("@kiwi/worker/process-files-spec", () => ({
    processFilesSpec: { name: "process-files" },
}));

mock.module("../../lib/archive-upload", () => ({
    expandArchiveUploadFiles: (files: File[]) => Effect.succeed({ ok: true as const, files }),
}));

mock.module("../../lib/graph", () => ({
    collectGraphClosure: () => Effect.succeed(["graph-1", "graph-2"]),
}));

mock.module("../../lib/graph/list", () => ({
    listAccessibleGraphs: () => Effect.succeed([]),
}));

mock.module("../../lib/repository-url", () => ({
    buildGitHubExternalCodeFile: () => {
        throw new Error("not expected");
    },
    loadRepositoryFromUrl: () => Effect.fail(new Error("not expected")),
    MAX_REPOSITORY_URLS: 10,
    RepositoryUrlError: class RepositoryUrlError extends Error {},
}));

mock.module("../../lib/workflow-cancellation", () => ({
    cancelActiveFileProcessingWorkflowRuns: () =>
        Effect.sync(() => {
            operationLog.push("file-workflows-cancelled");
        }),
    cancelActiveGraphWorkflowRuns: () =>
        Effect.sync(() => {
            operationLog.push("graph-workflows-cancelled");
        }),
}));

mock.module("../../lib/graph/access", () => ({
    assertCanCreateTeamGraph: () => Effect.succeed({ team: { organizationId: "org-1" } }),
    assertCanCreateTopLevelGraph: () => Effect.succeed({ organizationId: "org-1" }),
    assertCanCreateUnderParentGraph: () => Effect.succeed(undefined),
    assertCanManageGraphFiles: () => Effect.succeed(existingGraph),
    assertCanPatchGraph: () => Effect.succeed(existingGraph),
    assertCanViewGraph: () => Effect.succeed(existingGraph),
    resolveGraphOwnerRoot: () => Effect.succeed({ mode: "organization", organizationId: "org-1" }),
    selectGraphFields: {},
}));

mock.module("../../lib/graph/route", () => ({
    assertConfiguredUploadModels: () => Effect.succeed(undefined),
    cleanupFailedGraphCreation: () => Effect.succeed(undefined),
    cleanupUploadedKeys: () => Effect.succeed(0),
    commitGraphFileUploads: () => Effect.succeed({ graph: existingGraph, addedFiles: [], processRunId: null }),
    inferSupportedUploadedFiles: (files: Array<{ file: File; checksum: string }>) => ({
        ok: true as const,
        files: files.map(({ file, checksum }) => ({ file, checksum, type: "text" as const })),
    }),
    mapGraphError: (status: (code: number, body: unknown) => unknown, error: unknown) => {
        if (error instanceof Error && error.message === "GRAPH_NOT_FOUND") {
            return status(404, {
                status: "error",
                message: "Graph not found",
                code: "GRAPH_NOT_FOUND",
            });
        }

        return status(500, {
            status: "error",
            message: "Internal server error",
            code: "INTERNAL_SERVER_ERROR",
        });
    },
    restoreGraphFileChangeFailure: () => Effect.succeed(undefined),
    selectFileFields: {},
    selectGraphDetailFileFields: {},
    toGraphFileRecord: (file: unknown) => file,
    uniqueFilesByChecksum: (files: File[]) =>
        Effect.succeed(
            scenario === "add-duplicate-files"
                ? files[0]
                    ? [{ file: files[0], checksum: "duplicate-checksum" }]
                    : []
                : files.map((file) => ({ file, checksum: `checksum:${file.name}` }))
        ),
    unsupportedUploadResponse: (status: (code: number, body: unknown) => unknown) =>
        status(400, {
            status: "error",
            message: "Unsupported upload",
            code: "UNSUPPORTED_UPLOAD",
        }),
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia({ name: "graph-test-auth" }).derive({ as: "scoped" }, () => ({
        user: authUser,
    })),
}));

mock.module("../../middleware/permissions", () => ({
    requirePermissions: () => () => undefined,
}));

mock.module("../../workflow", () => ({
    wo: {
        runWorkflow: async (spec: { name: string }) => {
            operationLog.push(`workflow-enqueued:${spec.name}`);
            return {
                workflowRun: {
                    id: `${spec.name}-workflow-1`,
                },
            };
        },
    },
}));

// Dynamic import is required because this test intentionally mocks route dependencies before module evaluation.
const { graphRoute } = await import("../graph");

describe("graph route characterization", () => {
    beforeEach(() => {
        scenario = "create-no-files";
        dbSelectCount = 0;
        txSelectCount = 0;
        operationLog.length = 0;
        uploadedFileNames.length = 0;
        deletedS3Keys.length = 0;
        listedPrefixes.length = 0;
    });

    test("create graph with no files returns workflowRunId null and a ready graph", async () => {
        const response = await new Elysia().use(graphRoute).handle(
            new Request("http://localhost/graphs/", {
                method: "POST",
                body: (() => {
                    const form = new FormData();
                    form.set("name", "Empty graph");
                    return form;
                })(),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.status).toBe("success");
        expect(body.data.graph).toMatchObject({
            id: "graph-created",
            name: "Empty graph",
            state: "ready",
        });
        expect(body.data.files).toEqual([]);
        expect(body.data.workflowRunId).toBeNull();
        expect(uploadedFileNames).toEqual([]);
    });

    test("add files with duplicate checksums returns no duplicate process work", async () => {
        scenario = "add-duplicate-files";
        const form = new FormData();
        form.append("files", new File(["duplicate content"], "alpha.txt", { type: "text/plain" }));
        form.append("files", new File(["duplicate content"], "beta.txt", { type: "text/plain" }));

        const response = await new Elysia().use(graphRoute).handle(
            new Request("http://localhost/graphs/graph-1/files", {
                method: "POST",
                body: form,
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data.graph).toEqual(existingGraph);
        expect(body.data.addedFiles).toEqual([]);
        expect(body.data.workflowRunId).toBeNull();
        expect(uploadedFileNames).toEqual([]);
        expect(operationLog).toEqual([]);
    });

    test("delete files rejects invalid file keys with INVALID_FILE_IDS", async () => {
        scenario = "delete-invalid-files";

        const response = await new Elysia().use(graphRoute).handle(
            new Request("http://localhost/graphs/graph-1/files", {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    fileKeys: ["graphs/graph-1/file-1.txt", "graphs/graph-1/missing.txt"],
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.status).toBe("error");
        expect(body.code).toBe("INVALID_FILE_IDS");
    });

    test("delete files enqueues work after DB state changes and then cancels active processing runs", async () => {
        scenario = "delete-files-success";

        const response = await new Elysia().use(graphRoute).handle(
            new Request("http://localhost/graphs/graph-1/files", {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fileKeys: ["graphs/graph-1/file-1.txt"] }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data.removedFileKeys).toEqual(["graphs/graph-1/file-1.txt"]);
        expect(body.data.workflowRunId).toBe("delete-graph-files-workflow-1");
        expect(operationLog).toEqual([
            "graph-state-updated",
            "files-marked-deleted",
            "workflow-enqueued:delete-graph-files",
            "file-workflows-cancelled",
        ]);
    });

    test("delete graph cancels active workflows and reports cleanup warnings without changing response shape", async () => {
        scenario = "delete-graph-warning";

        const response = await new Elysia().use(graphRoute).handle(
            new Request("http://localhost/graphs/graph-1", {
                method: "DELETE",
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data).toEqual({
            graphId: "graph-1",
            deletedGraphCount: 2,
            deletedFileCount: 1,
            s3Cleanup: {
                attemptedKeyCount: 2,
                failedKeyCount: 2,
            },
            warnings: ["Some S3 objects could not be deleted after the graph was removed"],
        });
        expect(operationLog).toEqual(["graph-workflows-cancelled", "graph-deleted"]);
        expect(listedPrefixes).toEqual(["graphs/graph-1/", "graphs/graph-2/"]);
        expect(deletedS3Keys).toEqual(["graphs/graph-1/file-1.txt", "graphs/graph-1/extra.txt"]);
    });
});
