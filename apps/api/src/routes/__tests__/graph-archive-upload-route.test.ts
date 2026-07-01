import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Elysia } from "elysia";

const uploadedFiles: Array<{ graphId: string; fileId: string; name: string }> = [];
let archiveExpansionMode: "success" | "limit" = "success";
const workflowInputs: Array<{
    graphId: string;
    fileIds: string[];
    processRunId: string;
    code?: { kind: "repository"; retiredFileIds?: string[] };
}> = [];
const loadedUrls: string[] = [];
const insertedFileValues: Array<{
    name: string;
    type: string;
    mimeType: string;
    key: string;
    storageKind?: string;
    externalProvider?: string;
    externalUrl?: string;
    metadata?: string;
    checksum?: string;
}> = [];
const existingChecksumRows: Array<{ checksum: string }> = [];
const retryFileRows: Array<{
    id: string;
    type: string;
    status: string;
    processStep: string;
    processErrorCode: string | null;
}> = [];
const supersededFileIds: string[] = [];
let repositoryLoadMode: "success" | "limit-error" | "git-error" = "success";

class RepositoryUrlError extends Error {
    constructor(
        public readonly kind: "validation" | "limit" | "load",
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "RepositoryUrlError";
    }
}
let uploadModelMode: "success" | "missing" = "success";

const graphRow = {
    id: "graph-1",
    name: "Archive graph",
    description: null,
    organizationId: "org-1",
    teamId: null,
    userId: null,
    graphId: null,
    hidden: false,
    state: "updating",
};

const existingGraph = {
    ...graphRow,
    name: "Existing graph",
};

function graphFileRows(
    values: Array<{
        id: string;
        graphId: string;
        name: string;
        size: number;
        type: string;
        mimeType: string;
        key: string;
        checksum: string;
        metadata?: string;
    }>
) {
    return values.map((file) => ({
        id: file.id,
        graphId: file.graphId,
        name: file.name,
        size: file.size,
        type: file.type,
        mimeType: file.mimeType,
        key: file.key,
        checksum: file.checksum,
        metadata: file.metadata,
        deleted: false,
    }));
}

function insertReturning(values: unknown) {
    if (Array.isArray(values)) {
        if (values.every((value) => typeof value === "object" && value !== null && "fileId" in value)) {
            return undefined;
        }

        return graphFileRows(
            values as Array<{
                id: string;
                graphId: string;
                name: string;
                size: number;
                type: string;
                mimeType: string;
                key: string;
                checksum: string;
                metadata?: string;
            }>
        );
    }

    if (typeof values === "object" && values !== null && "name" in values) {
        return [graphRow];
    }

    if (typeof values === "object" && values !== null && "status" in values) {
        return [{ id: "process-run-1" }];
    }

    return undefined;
}

function selectableRows<TRows, TLimitedRows>(rows: TRows[], limitedRows: TLimitedRows[]) {
    return {
        limit: async (count: number) => limitedRows.slice(0, count),
        then: <TResult1 = TRows[], TResult2 = never>(
            onfulfilled?: ((value: TRows[]) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) => Promise.resolve(rows).then(onfulfilled, onrejected),
    };
}

function effectWithReturning<T>(value: T, returningValue: unknown) {
    return Object.assign(Effect.succeed(value), {
        returning: () => Effect.succeed(returningValue),
    });
}

function runTransactionResult<T>(result: T | PromiseLike<T> | Effect.Effect<T>) {
    return Effect.isEffect(result) ? Effect.runPromise(result) : result;
}

const db = {
    insert: () => ({
        values: (values: unknown) => ({
            returning: () => insertReturning(values),
        }),
    }),
    select: () => ({
        from: () => ({
            where: () => selectableRows(existingChecksumRows, retryFileRows),
        }),
    }),
    transaction: <T>(callback: (tx: typeof transactionDb) => T | PromiseLike<T> | Effect.Effect<T>) =>
        runTransactionResult(callback(transactionDb)),
};

const transactionDb = {
    insert: () => ({
        values: (values: unknown) => {
            if (
                (Array.isArray(values) &&
                    values.every((value) => typeof value === "object" && value !== null && "fileId" in value)) ||
                (typeof values === "object" && values !== null && "fileId" in values)
            ) {
                return Effect.succeed(undefined);
            }

            return {
                onConflictDoNothing: () => ({
                    returning: () => {
                        if (Array.isArray(values)) {
                            insertedFileValues.push(
                                ...(values as Array<{
                                    name: string;
                                    type: string;
                                    mimeType: string;
                                    key: string;
                                    storageKind?: string;
                                    externalProvider?: string;
                                    externalUrl?: string;
                                    metadata?: string;
                                    checksum?: string;
                                }>)
                            );
                        }

                        return Effect.succeed(insertReturning(values));
                    },
                }),
                returning: () => Effect.succeed(insertReturning(values)),
            };
        },
    }),
    update: () => ({
        set: (values: Record<string, unknown>) => ({
            where: () =>
                effectWithReturning(
                    undefined,
                    values.deleted === true ? supersededFileIds.map((id) => ({ id })) : [existingGraph]
                ),
        }),
    }),
};

function runMockDbEffect(thunk: (database: typeof db) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(db);
    return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
}

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed(db),
    DatabaseError: class DatabaseError extends Error {},
    DatabaseLayer: Layer.empty,
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
    tryDb: runMockDbEffect,
    tryDbVoid: (thunk: (database: typeof db) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) =>
        Effect.asVoid(runMockDbEffect(thunk)),
}));

mock.module("@kiwi/db", () => ({ betterAuthDb: db, db }));

mock.module("../../env", () => ({
    env: {
        AUTH_SECRET: "test-secret",
        S3_BUCKET: "test-bucket",
    },
}));

mock.module("@kiwi/logger", () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
}));

mock.module("@kiwi/files", () => ({
    FileStorageLive: Layer.empty,
    deleteFile: () => Effect.succeed(true),
    listFiles: () => Effect.succeed([]),
    putGraphFile: (graphId: string, fileId: string, name: string) => {
        uploadedFiles.push({ graphId, fileId, name });
        return Effect.succeed({ key: `graphs/${graphId}/${fileId}.txt`, type: "text/plain" });
    },
}));

mock.module("../../workflow", () => ({
    wo: {
        runWorkflow: async (_spec: unknown, input: { graphId: string; fileIds: string[]; processRunId: string }) => {
            workflowInputs.push(input);
            return { workflowRun: { id: "workflow-1" } };
        },
    },
}));

mock.module("@kiwi/worker/process-files-spec", () => ({
    processFilesSpec: { name: "process-files" },
}));

mock.module("@kiwi/worker/delete-graph-files-spec", () => ({
    deleteGraphFilesSpec: { name: "delete-graph-files" },
}));

mock.module("@kiwi/ai/models", () => ({
    AiModelRegistry: Effect.succeed({}),
    getDefaultModelOrganizationId: () => Effect.succeed("org-1"),
    resolveRequiredModelAdapter: () => Effect.succeed({}),
    makeAiModelRegistryLayer: () => Layer.empty,
}));

mock.module("../../lib/archive-upload", () => ({
    expandArchiveUploadFiles: (files: File[]) =>
        Effect.sync(() => {
            if (archiveExpansionMode === "limit") {
                return {
                    ok: false,
                    kind: "limit",
                    fileName: "bundle.zip",
                    message: "Upload expands to too many files",
                };
            }

            return {
                ok: true,
                files: files.flatMap((file) =>
                    file.name === "bundle.zip"
                        ? [
                              new File(["alpha"], "alpha.txt", { type: "text/plain" }),
                              new File(["beta"], "beta.txt", { type: "text/plain" }),
                          ]
                        : [file]
                ),
            };
        }),
}));

mock.module("../../lib/graph/upload-file-type", () => ({
    inferSupportedUploadedFiles: (
        files: Array<{
            file: File;
            checksum: string;
        }>
    ) => ({
        ok: true,
        files: files.map((file) => ({
            ...file,
            type: file.file.name.endsWith(".ts") ? "code" : "text",
        })),
    }),
    unsupportedUploadResponse: (statusFn: (code: number, body: unknown) => unknown) =>
        statusFn(415, { status: "error", code: "UNSUPPORTED_FILE_TYPE" }),
    assertConfiguredUploadModels: () =>
        uploadModelMode === "missing" ? Effect.fail(new Error("MODEL_NOT_CONFIGURED")) : Effect.succeed(undefined),
}));

mock.module("../../lib/repository-url", () => ({
    MAX_REPOSITORY_URLS: 5,
    RepositoryUrlError,
    buildGitHubExternalCodeFile: ({
        repositoryUrl,
        commitSha,
        path,
    }: {
        repositoryUrl: string;
        commitSha: string;
        path: string;
    }) => {
        const match = repositoryUrl.match(/^https:\/\/github\.com\/acme\/([^/]+)\.git$/);
        if (!match) {
            return null;
        }

        const repositoryName = match[1];
        return {
            provider: "github",
            rawUrl: `https://raw.githubusercontent.com/acme/${repositoryName}/${commitSha}/${path}`,
            htmlUrl: `https://github.com/acme/${repositoryName}/blob/${commitSha}/${path}`,
            key: `external:github:acme/${repositoryName}@${commitSha}:${path}`,
        };
    },
    loadRepositoryFromUrl: (url: string) =>
        Effect.gen(function* () {
            loadedUrls.push(url);
            if (repositoryLoadMode === "limit-error") {
                return yield* Effect.fail(
                    new RepositoryUrlError("limit", "Repository contains too many supported code files")
                );
            }
            if (repositoryLoadMode === "git-error") {
                return yield* Effect.fail(
                    new RepositoryUrlError("load", "Repository could not be loaded", {
                        cause: new Error(
                            "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
                        ),
                    })
                );
            }

            const repositoryName = url.includes("tools") ? "tools" : "widgets";
            return {
                url: `https://github.com/acme/${repositoryName}.git`,
                name: repositoryName,
                commitSha: "commit-1",
                files:
                    repositoryName === "tools"
                        ? [
                              {
                                  path: "src/index.ts",
                                  content:
                                      "import { helper } from './helper';\nexport function main() { return helper(); }\n",
                                  size: 75,
                              },
                          ]
                        : [
                              {
                                  path: "src/index.ts",
                                  content:
                                      "import { helper } from './helper';\nexport function main() { return helper(); }\n",
                                  size: 75,
                              },
                              {
                                  path: "src/helper.ts",
                                  content: "export function helper() { return 1; }\n",
                                  size: 38,
                              },
                          ],
            };
        }),
}));

mock.module("../../lib/graph", () => ({
    collectGraphClosure: () => Effect.succeed([]),
}));

mock.module("../../lib/graph/list", () => ({
    listAccessibleGraphs: () => Effect.succeed([]),
}));

mock.module("../../lib/workflow-cancellation", () => ({
    cancelActiveFileProcessingWorkflowRuns: () => Effect.succeed(undefined),
    cancelActiveGraphWorkflowRuns: () => Effect.succeed(undefined),
}));

mock.module("../../lib/graph/access", () => ({
    assertCanCreateTopLevelGraph: () => Effect.succeed({ organizationId: "org-1" }),
    assertCanCreateUnderParentGraph: () => Effect.succeed(undefined),
    assertCanCreateTeamGraph: () => Effect.succeed({ team: { id: "team-1", organizationId: "org-1" } }),
    assertCanManageGraphFiles: () => Effect.succeed(existingGraph),
    assertCanPatchGraph: () => Effect.succeed(existingGraph),
    assertCanViewGraph: () => Effect.succeed(existingGraph),
    resolveGraphOwnerRoot: () => Effect.succeed({ mode: "organization", organizationId: "org-1" }),
    selectGraphFields: {},
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
        session: { session: { activeOrganizationId: "org-1" }, user: { id: "user-1" } },
        user: { id: "user-1", email: "user@example.com" },
    })),
}));

mock.module("../../middleware/permissions", () => ({
    requirePermissions: () => () => undefined,
}));

// Dynamic import required so Bun applies mock.module registrations before route module evaluation.
const { graphRoute } = await import("../graph");

function app() {
    return new Elysia().use(graphRoute);
}

function archiveFormData(name?: string) {
    const form = new FormData();
    if (name) {
        form.set("name", name);
    }
    form.append("files", new File(["zip"], "bundle.zip", { type: "application/zip" }));
    return form;
}

describe("graph route archive uploads", () => {
    beforeEach(() => {
        uploadedFiles.length = 0;
        workflowInputs.length = 0;
        loadedUrls.length = 0;
        insertedFileValues.length = 0;
        existingChecksumRows.length = 0;
        supersededFileIds.length = 0;
        retryFileRows.length = 0;
        archiveExpansionMode = "success";
        repositoryLoadMode = "success";
        uploadModelMode = "success";
    });

    test("creates one graph file and workflow input per extracted archive file", async () => {
        const response = await app().handle(
            new Request("http://localhost/graphs/", {
                method: "POST",
                body: archiveFormData("Archive graph"),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.status).toBe("success");
        expect(body.data.files.map((file: { name: string }) => file.name)).toEqual(["alpha.txt", "beta.txt"]);
        expect(body.data.workflowRunId).toBe("workflow-1");
        expect(uploadedFiles.map((file) => file.name)).toEqual(["alpha.txt", "beta.txt"]);
        expect(workflowInputs).toHaveLength(1);
        expect(workflowInputs[0].fileIds).toEqual(body.data.files.map((file: { id: string }) => file.id));
    });

    test("adds one graph file and workflow input per extracted archive file", async () => {
        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/files", {
                method: "POST",
                body: archiveFormData(),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data.addedFiles.map((file: { name: string }) => file.name)).toEqual(["alpha.txt", "beta.txt"]);
        expect(body.data.workflowRunId).toBe("workflow-1");
        expect(uploadedFiles.map((file) => file.name)).toEqual(["alpha.txt", "beta.txt"]);
        expect(workflowInputs).toEqual([
            {
                graphId: "graph-1",
                fileIds: body.data.addedFiles.map((file: { id: string }) => file.id),
                processRunId: "process-run-1",
            },
        ]);
    });

    test("stores direct source uploads as code files", async () => {
        const form = new FormData();
        form.append("files", new File(["export const value = 1;\n"], "src/index.ts", { type: "text/plain" }));

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/files", {
                method: "POST",
                body: form,
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(insertedFileValues).toHaveLength(1);
        expect(insertedFileValues[0].name).toBe("src/index.ts");
        expect(insertedFileValues[0].type).toBe("code");
        expect(workflowInputs).toEqual([
            {
                graphId: "graph-1",
                fileIds: body.data.addedFiles.map((file: { id: string }) => file.id),
                processRunId: "process-run-1",
            },
        ]);
    });

    test("returns upload limit response when create archive expansion exceeds limits", async () => {
        archiveExpansionMode = "limit";

        const response = await app().handle(
            new Request("http://localhost/graphs/", {
                method: "POST",
                body: archiveFormData("Archive graph"),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(413);
        expect(body.status).toBe("error");
        expect(body.code).toBe("UPLOAD_LIMIT_EXCEEDED");
        expect(body.message).toBe("bundle.zip: Upload expands to too many files");
        expect(uploadedFiles).toEqual([]);
        expect(workflowInputs).toEqual([]);
    });

    test("returns upload limit response when add-files archive expansion exceeds limits", async () => {
        archiveExpansionMode = "limit";

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/files", {
                method: "POST",
                body: archiveFormData(),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(413);
        expect(body.status).toBe("error");
        expect(body.code).toBe("UPLOAD_LIMIT_EXCEEDED");
        expect(body.message).toBe("bundle.zip: Upload expands to too many files");
        expect(uploadedFiles).toEqual([]);
        expect(workflowInputs).toEqual([]);
    });

    test("adds repository URL code files with metadata and code workflow input", async () => {
        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    urls: [" https://github.com/acme/widgets ", "https://github.com/acme/widgets"],
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(loadedUrls).toEqual(["https://github.com/acme/widgets"]);
        expect(uploadedFiles).toEqual([]);
        expect(insertedFileValues.map((file) => file.type)).toEqual(["code", "code"]);
        expect(insertedFileValues.map((file) => file.mimeType)).toEqual(["text/plain", "text/plain"]);
        expect(insertedFileValues.map((file) => file.storageKind)).toEqual(["external", "external"]);
        expect(insertedFileValues.map((file) => file.externalProvider)).toEqual(["github", "github"]);
        expect(insertedFileValues.map((file) => file.externalUrl)).toEqual([
            "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
            "https://github.com/acme/widgets/blob/commit-1/src/helper.ts",
        ]);
        expect(insertedFileValues.map((file) => file.key)).toEqual([
            "external:github:acme/widgets@commit-1:src/index.ts",
            "external:github:acme/widgets@commit-1:src/helper.ts",
        ]);
        expect(insertedFileValues.map((file) => JSON.parse(file.metadata ?? "{}"))).toEqual([
            {
                repositoryUrl: "https://github.com/acme/widgets.git",
                repositoryName: "widgets",
                commitSha: "commit-1",
                path: "src/index.ts",
                external: {
                    provider: "github",
                    rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
                    htmlUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
                },
            },
            {
                repositoryUrl: "https://github.com/acme/widgets.git",
                repositoryName: "widgets",
                commitSha: "commit-1",
                path: "src/helper.ts",
                external: {
                    provider: "github",
                    rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/helper.ts",
                    htmlUrl: "https://github.com/acme/widgets/blob/commit-1/src/helper.ts",
                },
            },
        ]);
        expect(workflowInputs).toEqual([
            {
                graphId: "graph-1",
                fileIds: body.data.addedFiles.map((file: { id: string }) => file.id),
                processRunId: "process-run-1",
                code: { kind: "repository", retiredFileIds: [] },
            },
        ]);
    });

    test("passes superseded repository file ids to the processing workflow", async () => {
        supersededFileIds.push("old-file-1", "old-file-2");

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: ["https://github.com/acme/widgets"] }),
            })
        );

        expect(response.status).toBe(200);
        expect(workflowInputs).toHaveLength(1);
        expect(workflowInputs[0]?.code).toEqual({
            kind: "repository",
            retiredFileIds: ["old-file-1", "old-file-2"],
        });
    });

    test("keeps identical repository snapshot content once per repository", async () => {
        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    urls: ["https://github.com/acme/widgets", "https://github.com/acme/tools"],
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(insertedFileValues.map((file) => file.name)).toEqual([
            "widgets/src/index.ts",
            "widgets/src/helper.ts",
            "tools/src/index.ts",
        ]);
    });

    test("validates repository URL models before upload or workflow side effects", async () => {
        uploadModelMode = "missing";

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: ["https://github.com/acme/widgets"] }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.status).toBe("error");
        expect(body.code).toBe("MODEL_NOT_CONFIGURED");
        expect(uploadedFiles).toEqual([]);
        expect(insertedFileValues).toEqual([]);
        expect(workflowInputs).toEqual([]);
    });

    test("creates latest repository snapshot files even when earlier checksums already exist", async () => {
        const duplicateContent = "import { helper } from './helper';\nexport function main() { return helper(); }\n";
        const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(duplicateContent));
        existingChecksumRows.push({
            checksum: [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        });

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: ["https://github.com/acme/widgets"] }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data.addedFiles.map((file: { name: string }) => file.name)).toEqual([
            "widgets/src/index.ts",
            "widgets/src/helper.ts",
        ]);
        expect(uploadedFiles).toEqual([]);
        expect(workflowInputs[0]?.code).toEqual({ kind: "repository", retiredFileIds: [] });
    });

    test("still enqueues repository workflow when every URL file matches an older checksum", async () => {
        for (const content of [
            "import { helper } from './helper';\nexport function main() { return helper(); }\n",
            "export function helper() { return 1; }\n",
        ]) {
            const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
            existingChecksumRows.push({
                checksum: [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
            });
        }

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: ["https://github.com/acme/widgets"] }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.addedFiles.map((file: { name: string }) => file.name)).toEqual([
            "widgets/src/index.ts",
            "widgets/src/helper.ts",
        ]);
        expect(body.data.workflowRunId).toBe("workflow-1");
        expect(uploadedFiles).toEqual([]);
        expect(workflowInputs).toHaveLength(1);
    });

    test("retries code files without retiring repository siblings", async () => {
        retryFileRows.push({
            id: "file-code",
            type: "code",
            status: "failed",
            processStep: "failed",
            processErrorCode: "loader_failed",
        });

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/files/file-code/retry", {
                method: "POST",
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(workflowInputs).toEqual([
            {
                graphId: "graph-1",
                fileIds: ["file-code"],
                processRunId: "process-run-1",
                code: { kind: "repository", retiredFileIds: [] },
            },
        ]);
    });

    test("maps repository loader limits to upload limit responses", async () => {
        repositoryLoadMode = "limit-error";

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: ["https://github.com/acme/widgets"] }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(413);
        expect(body.code).toBe("UPLOAD_LIMIT_EXCEEDED");
        expect(uploadedFiles).toEqual([]);
        expect(workflowInputs).toEqual([]);
    });

    test("sanitizes repository git failures in client responses", async () => {
        repositoryLoadMode = "git-error";

        const response = await app().handle(
            new Request("http://localhost/graphs/graph-1/urls", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: ["https://github.com/acme/widgets"] }),
            })
        );
        const body = await response.json();
        const responseText = JSON.stringify(body);

        expect(response.status).toBe(400);
        expect(body.code).toBe("UNSUPPORTED_FILE_TYPE");
        expect(body.message).toBe("Repository could not be loaded");
        expect(responseText).not.toContain("fatal:");
        expect(responseText).not.toContain("terminal prompts disabled");
        expect(uploadedFiles).toEqual([]);
        expect(workflowInputs).toEqual([]);
    });
});
