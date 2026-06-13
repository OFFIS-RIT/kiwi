import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

const uploadedFiles: Array<{ graphId: string; fileId: string; name: string }> = [];
let archiveExpansionMode: "success" | "limit" = "success";
const workflowInputs: Array<{ graphId: string; fileIds: string[]; processRunId: string }> = [];

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

const db = {
    insert: () => ({
        values: (values: unknown) => ({
            returning: () => insertReturning(values),
        }),
    }),
    select: () => ({
        from: () => ({
            where: async () => [],
        }),
    }),
    transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
};

const transactionDb = {
    insert: () => ({
        values: (values: unknown) => ({
            onConflictDoNothing: () => ({
                returning: () => insertReturning(values),
            }),
            returning: () => insertReturning(values),
        }),
    }),
    update: () => ({
        set: () => ({
            where: () => ({
                returning: () => [existingGraph],
            }),
        }),
    }),
};

mock.module("@kiwi/db", () => ({ db }));

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
    deleteFile: async () => undefined,
    listFiles: async () => [],
    putGraphFile: async (graphId: string, fileId: string, name: string) => {
        uploadedFiles.push({ graphId, fileId, name });
        return { key: `graphs/${graphId}/${fileId}.txt`, type: "text/plain" };
    },
}));

mock.module("../../openworkflow", () => ({
    ow: {
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
    getDefaultModelOrganizationId: () => "org-1",
    resolveRequiredModelAdapter: async () => ({}),
}));

mock.module("../../lib/archive-upload", () => ({
    expandArchiveUploadFiles: async (files: File[]) => {
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
    },
}));

mock.module("../../lib/graph", () => ({
    collectGraphClosure: async () => [],
}));

mock.module("../../lib/graph-list", () => ({
    listAccessibleGraphs: async () => [],
}));

mock.module("../../lib/workflow-cancellation", () => ({
    cancelActiveFileProcessingWorkflowRuns: async () => undefined,
    cancelActiveGraphWorkflowRuns: async () => undefined,
}));

mock.module("../../lib/graph-access", () => ({
    assertCanCreateTopLevelGraph: async () => ({ organizationId: "org-1" }),
    assertCanCreateUnderParentGraph: async () => undefined,
    assertCanCreateTeamGraph: async () => ({ team: { id: "team-1", organizationId: "org-1" } }),
    assertCanManageGraphFiles: async () => existingGraph,
    assertCanPatchGraph: async () => existingGraph,
    assertCanViewGraph: async () => existingGraph,
    resolveGraphOwnerRoot: async () => ({ mode: "organization", organizationId: "org-1" }),
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
        archiveExpansionMode = "success";
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
});
