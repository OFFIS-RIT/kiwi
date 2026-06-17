import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";

let selectedFile: unknown;
let bindingRow: unknown = null;
let metadataCalls = 0;
let streamCalls = 0;
let selectCallCount = 0;
const providerReadCalls: Array<{ resourceId: string; path: string; versionId?: string; etag?: string }> = [];

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
    deleteFile: () => Effect.succeed(true),
    getFileMetadata: () => {
        metadataCalls += 1;
        return Effect.succeed({ size: 12, type: "text/plain", lastModified: null });
    },
    getFileStream: () => {
        streamCalls += 1;
        return Effect.succeed({ content: new Blob(["hello world\n"]).stream(), size: 12, type: "text/plain", lastModified: null });
    },
    listFiles: () => Effect.succeed([]),
    putGraphFile: () => Effect.succeed({ key: "key", type: "text/plain" }),
}));

mock.module("../connectors", () => ({
    createProviderClient: () =>
        Effect.succeed({
            readFile: (locator: { resourceId: string; path: string; versionId?: string; etag?: string }) =>
                Effect.sync(() => {
                    providerReadCalls.push(locator);
                    return "export const older = true;\n";
                }),
        }),
}));

// Dynamic import is required so module mocks are installed before the graph file proxy module is evaluated.
const { getGraphFileProxyResponse } = await import("../graph/file-proxy");

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
            connectorBindingId: null,
            metadata: null,
        };
    });

    test("streams internal files from S3", async () => {
        const result = await Effect.runPromise(getGraphFileProxyResponse({
            graphId: "graph-1",
            fileId: "file-1",
            request: new Request("http://localhost/file"),
            bucket: "bucket",
        }));

        expect(result.status).toBe("ok");
        expect(metadataCalls).toBe(1);
        expect(streamCalls).toBe(1);
        if (result.status === "ok") {
            expect(result.response.status).toBe(200);
        }
    });

    test("redirects external GitHub files to immutable raw URLs without S3 calls", async () => {
        selectedFile = {
            key: "external:github:acme/widgets@commit-1:src/index.ts",
            name: "widgets/src/index.ts",
            mimeType: "text/plain",
            storageKind: "external",
            externalProvider: "github",
            externalUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
            connectorBindingId: null,
            metadata: JSON.stringify({
                schemaVersion: 2,
                provider: "github",
                bindingId: "binding-1",
                resourceKind: "git-repository",
                providerResourceId: "1",
                resourceDisplayName: "acme/widgets",
                path: "src/index.ts",
                displayName: "index.ts",
                versionId: "commit-1",
                rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
                webUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
            }),
        };

        const result = await Effect.runPromise(getGraphFileProxyResponse({
            graphId: "graph-1",
            fileId: "file-1",
            request: new Request("http://localhost/file"),
            bucket: "bucket",
        }));

        expect(result.status).toBe("ok");
        expect(metadataCalls).toBe(0);
        expect(streamCalls).toBe(0);
        expect(providerReadCalls).toEqual([]);
        if (result.status === "ok") {
            expect(result.response.status).toBe(307);
            expect(result.response.headers.get("location")).toBe(
                "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts"
            );
        }
    });

    test("reads connector-backed files at the metadata version without S3 access", async () => {
        selectedFile = {
            key: "connector:binding-1:commit-2:src/index.ts",
            name: "widgets/src/index.ts",
            mimeType: "text/plain",
            storageKind: "external",
            externalProvider: "github",
            externalUrl: "https://raw.githubusercontent.com/acme/widgets/commit-2/src/index.ts",
            connectorBindingId: "binding-1",
            metadata: JSON.stringify({
                schemaVersion: 2,
                provider: "github",
                bindingId: "binding-1",
                resourceKind: "git-repository",
                providerResourceId: "1",
                resourceDisplayName: "acme/widgets",
                path: "src/index.ts",
                displayName: "index.ts",
                versionId: "commit-1",
                rawUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
                webUrl: "https://github.com/acme/widgets/blob/commit-1/src/index.ts",
            }),
        };
        bindingRow = {
            binding: {
                providerResourceId: "1",
                resourceDisplayName: "acme/widgets",
                resourceWebUrl: "https://github.com/acme/widgets",
                versionName: "main",
            },
            installation: { status: "active" },
            connector: { provider: "github", status: "active" },
        };

        const result = await Effect.runPromise(getGraphFileProxyResponse({
            graphId: "graph-1",
            fileId: "file-1",
            request: new Request("http://localhost/file"),
            bucket: "bucket",
        }));

        expect(result.status).toBe("ok");
        expect(metadataCalls).toBe(0);
        expect(streamCalls).toBe(0);
        expect(providerReadCalls).toEqual([{ resourceId: "1", path: "src/index.ts", versionId: "commit-1" }]);
        if (result.status === "ok") {
            expect(result.response.status).toBe(200);
            await expect(result.response.text()).resolves.toBe("export const older = true;\n");
        }
    });
});
