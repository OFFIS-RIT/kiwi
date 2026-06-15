import { beforeEach, describe, expect, mock, test } from "bun:test";

let selectedFile: unknown;
let bindingRow: unknown = null;
let metadataCalls = 0;
let streamCalls = 0;
let selectCallCount = 0;
const providerReadCalls: Array<{ path: string; commitSha: string }> = [];

function createSelectQuery() {
    const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => {
            selectCallCount += 1;
            if (selectCallCount === 1) {
                return selectedFile ? [selectedFile] : [];
            }
            return bindingRow ? [bindingRow] : [];
        },
    };
    return chain;
}

mock.module("@kiwi/db", () => ({
    db: {
        select: () => createSelectQuery(),
    },
}));

mock.module("@kiwi/files", () => ({
    deleteFile: async () => undefined,
    getFileMetadata: async () => {
        metadataCalls += 1;
        return { size: 12, type: "text/plain", lastModified: null };
    },
    getFileStream: async () => {
        streamCalls += 1;
        return { content: new Blob(["hello world\n"]).stream(), size: 12, type: "text/plain" };
    },
    listFiles: async () => [],
    putGraphFile: async () => ({ key: "key", type: "text/plain" }),
}));

mock.module("../connectors", () => ({
    createProviderClient: async () => ({
        readFile: async (_repository: unknown, path: string, commitSha: string) => {
            providerReadCalls.push({ path, commitSha });
            return "export const older = true;\n";
        },
    }),
}));

// Dynamic import is required so module mocks are installed before graph-file-proxy is evaluated.
const { getGraphFileProxyResponse } = await import("../graph-file-proxy");

describe("graph file proxy", () => {
    beforeEach(() => {
        metadataCalls = 0;
        streamCalls = 0;
        selectCallCount = 0;
        providerReadCalls.length = 0;
        bindingRow = null;
        selectedFile = {
            key: "graphs/graph-1/file-1.txt",
            name: "file.txt",
            mimeType: "text/plain",
            storageKind: "internal",
            externalProvider: null,
            externalUrl: null,
            repositoryBindingId: null,
            metadata: null,
        };
    });

    test("streams internal files from S3", async () => {
        const result = await getGraphFileProxyResponse({
            graphId: "graph-1",
            fileId: "file-1",
            request: new Request("http://localhost/file"),
            bucket: "bucket",
        });

        expect(result.status).toBe("ok");
        expect(metadataCalls).toBe(1);
        expect(streamCalls).toBe(1);
        if (result.status === "ok") {
            expect(result.response.status).toBe(200);
        }
    });

    test("redirects external GitHub files to immutable HTML URLs without S3 calls", async () => {
        selectedFile = {
            key: "external:github:acme/widgets@commit-1:src/index.ts",
            name: "widgets/src/index.ts",
            mimeType: "text/plain",
            storageKind: "external",
            externalProvider: "github",
            externalUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
            repositoryBindingId: null,
            metadata: JSON.stringify({
                repositoryUrl: "https://github.com/acme/widgets.git",
                repositoryName: "widgets",
                commitSha: "commit-1",
                path: "src/index.ts",
                external: {
                    provider: "github",
                    rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
                    htmlUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
                },
            }),
        };

        const result = await getGraphFileProxyResponse({
            graphId: "graph-1",
            fileId: "file-1",
            request: new Request("http://localhost/file"),
            bucket: "bucket",
        });

        expect(result.status).toBe("ok");
        expect(metadataCalls).toBe(0);
        expect(streamCalls).toBe(0);
        expect(providerReadCalls).toEqual([]);
        if (result.status === "ok") {
            expect(result.response.status).toBe(307);
            expect(result.response.headers.get("location")).toBe(
                "https://github.com/acme/widgets/blob/commit-1/src/index.ts"
            );
        }
    });

    test("reads connector-backed files at the row commit without S3 access", async () => {
        selectedFile = {
            key: "connector:binding-1:commit-2:src/index.ts",
            name: "widgets/src/index.ts",
            mimeType: "text/plain",
            storageKind: "external",
            externalProvider: "github",
            externalUrl: "https://raw.githubusercontent.com/acme/widgets/commit-2/src/index.ts",
            repositoryBindingId: "binding-1",
            metadata: JSON.stringify({
                repositoryUrl: "https://github.com/acme/widgets.git",
                repositoryName: "widgets",
                commitSha: "commit-1",
                path: "src/index.ts",
            }),
        };
        bindingRow = {
            binding: {
                providerRepositoryId: "1",
                repositoryFullName: "acme/widgets",
                repositoryHtmlUrl: "https://github.com/acme/widgets",
                branch: "main",
            },
            installation: { status: "active" },
            connector: { provider: "github", status: "active" },
        };

        const result = await getGraphFileProxyResponse({
            graphId: "graph-1",
            fileId: "file-1",
            request: new Request("http://localhost/file"),
            bucket: "bucket",
        });

        expect(result.status).toBe("ok");
        expect(metadataCalls).toBe(0);
        expect(streamCalls).toBe(0);
        expect(providerReadCalls).toEqual([{ path: "src/index.ts", commitSha: "commit-1" }]);
        if (result.status === "ok") {
            expect(result.response.status).toBe(200);
            await expect(result.response.text()).resolves.toBe("export const older = true;\n");
        }
    });
});
