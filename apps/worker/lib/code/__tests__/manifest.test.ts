import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestDatabaseLayer, makeTestFileStorageLayer, runTestEffect } from "../../test-support/effect";

type MockFileRow = {
    id: string;
    name: string;
    key: string;
    storageKind: string;
    externalUrl: string | null;
    externalProvider: string | null;
    connectorBindingId: string | null;
    metadata: string;
};

const baseRows: MockFileRow[] = [
    {
        id: "file-new",
        name: "widgets/src/index.ts",
        key: "key-new",
        storageKind: "internal",
        externalUrl: null,
        externalProvider: null,
        connectorBindingId: null,
        metadata: JSON.stringify({
            repositoryUrl: "https://github.com/acme/widgets.git",
            repositoryName: "widgets",
            commitSha: "commit-1",
            path: "src/index.ts",
        }),
    },
    {
        id: "file-existing",
        name: "widgets/src/helper.ts",
        key: "key-existing",
        storageKind: "internal",
        externalUrl: null,
        externalProvider: null,
        connectorBindingId: null,
        metadata: JSON.stringify({
            repositoryUrl: "https://github.com/acme/widgets.git",
            repositoryName: "widgets",
            commitSha: "commit-1",
            path: "src/helper.ts",
        }),
    },
    {
        id: "file-other",
        name: "other/src/helper.ts",
        key: "key-other",
        storageKind: "internal",
        externalUrl: null,
        externalProvider: null,
        connectorBindingId: null,
        metadata: JSON.stringify({
            repositoryUrl: "https://github.com/acme/other.git",
            repositoryName: "other",
            commitSha: "commit-1",
            path: "src/helper.ts",
        }),
    },
];

const fileContents: Record<string, string> = {
    "key-new": "import { helper } from '../../__tests__/helper';\nexport function main() { return helper(); }\n",
    "key-existing": "export function helper() { return 1; }\n",
    "key-other": "export function helper() { return 2; }\n",
    "key-connector-new": "import { shared } from '../../__tests__/shared';\nexport const main = () => shared;\n",
    "key-connector-existing": "export const shared = 1;\n",
    "key-connector-other-binding": "export const shared = 2;\n",
    "key-connector-feature": "export const feature = true;\n",
};

let rows = [...baseRows];
let selectedFileIds = ["file-new"];
let selectCallCount = 0;
let uploadedManifest: unknown;

const mockDb = {
    select: () => ({
        from: () => ({
            where: () => {
                selectCallCount += 1;
                return Effect.succeed(
                    selectCallCount === 1 ? rows.filter((row) => selectedFileIds.includes(row.id)) : rows
                );
            },
        }),
    }),
};

const TestManifestLayer = Layer.mergeAll(
    makeTestDatabaseLayer(mockDb),
    makeTestFileStorageLayer({
        getFile: (key: string, _bucket: string, _type: "text") => {
            const content = fileContents[key];
            return Effect.succeed(content ? { type: "text" as const, content } : null);
        },
        putNamedFile: (_name: string, content: unknown) =>
            Effect.sync(() => {
                uploadedManifest = JSON.parse(String(content));
                return { key: "manifest-key", type: "application/json" };
            }),
    })
);
const runWorkerTestEffect = <T, E>(effect: Effect.Effect<T, E, Layer.Layer.Success<typeof TestManifestLayer>>) =>
    runTestEffect(effect, TestManifestLayer);


mock.module("../../runtime/effect", () => ({
    withWorkerDb: (work: (db: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) => {
        const result = work(mockDb);
        return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
    },
    withWorkerDbVoid: (work: (db: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) => {
        const result = work(mockDb);
        return Effect.asVoid(Effect.isEffect(result) ? result : Effect.promise(async () => await result));
    },
    runWorkerEffect: <T, E>(effect: Effect.Effect<T, E>) => Effect.runPromise(effect),
}));


mock.module("../../../env", () => ({
    env: { S3_BUCKET: "test-bucket" },
}));

// Dynamic import is required so module mocks and env are installed before worker modules are evaluated.
const { loadCodeRepositoryContext, loadCodeRepositoryContextsByBranch, prepareCodeManifest } =
    await import("../manifest");
const { readFileContentSource } = await import("../../files/content-source");

describe("prepareCodeManifest", () => {
    beforeEach(() => {
        selectCallCount = 0;
        uploadedManifest = undefined;
        selectedFileIds = ["file-new"];
        rows = [...baseRows];
    });

    test("includes active files from the same repository commit as selected files", async () => {
        const key = await runWorkerTestEffect(
            prepareCodeManifest({ graphId: "graph-1", fileIds: ["file-new"], processRunId: "run-1" })
        );

        expect(key).toBe("manifest-key");
        expect((uploadedManifest as { files: Array<{ path: string }> }).files.map((file) => file.path).sort()).toEqual([
            "src/helper.ts",
            "src/index.ts",
        ]);
    });

    test("returns repository scopes for fast layer persistence", async () => {
        const context = await runWorkerTestEffect(
            loadCodeRepositoryContext({ graphId: "graph-1", fileIds: ["file-new"] })
        );

        expect(context?.repositoryScopes).toEqual(["repository:https://github.com/acme/widgets.git\0commit-1"]);
        expect(context?.files.map((file) => file.path).sort()).toEqual(["src/helper.ts", "src/index.ts"]);
    });

    test("includes unchanged connector siblings from the same binding across mixed commits", async () => {
        rows = [
            {
                id: "file-connector-new",
                name: "widgets/src/index.ts",
                key: "key-connector-new",
                storageKind: "internal",
                externalUrl: null,
                externalProvider: null,
                connectorBindingId: "binding-1",
                metadata: JSON.stringify({
                    repositoryUrl: "https://github.com/acme/widgets.git",
                    repositoryName: "widgets",
                    commitSha: "commit-2",
                    path: "src/index.ts",
                }),
            },
            {
                id: "file-connector-existing",
                name: "widgets/src/shared.ts",
                key: "key-connector-existing",
                storageKind: "internal",
                externalUrl: null,
                externalProvider: null,
                connectorBindingId: "binding-1",
                metadata: JSON.stringify({
                    repositoryUrl: "https://github.com/acme/widgets.git",
                    repositoryName: "widgets",
                    commitSha: "commit-1",
                    path: "src/shared.ts",
                }),
            },
            {
                id: "file-connector-other-binding",
                name: "widgets/src/shared.ts",
                key: "key-connector-other-binding",
                storageKind: "internal",
                externalUrl: null,
                externalProvider: null,
                connectorBindingId: "binding-2",
                metadata: JSON.stringify({
                    repositoryUrl: "https://github.com/acme/widgets.git",
                    repositoryName: "widgets",
                    commitSha: "commit-1",
                    path: "src/shared.ts",
                }),
            },
        ];
        selectedFileIds = ["file-connector-new"];

        const key = await runWorkerTestEffect(
            prepareCodeManifest({ graphId: "graph-1", fileIds: selectedFileIds, processRunId: "run-1" })
        );

        expect(key).toBe("manifest-key");
        expect((uploadedManifest as { files: Array<{ path: string }> }).files.map((file) => file.path).sort()).toEqual([
            "src/index.ts",
            "src/shared.ts",
        ]);
        expect(
            (uploadedManifest as { files: Array<{ fileId: string }> }).files.map((file) => file.fileId).sort()
        ).toEqual(["file-connector-existing", "file-connector-new"]);
    });

    test("groups connector repository contexts by selected branch", async () => {
        rows = [
            {
                id: "file-main",
                name: "widgets/src/index.ts",
                key: "key-new",
                storageKind: "internal",
                externalUrl: null,
                externalProvider: null,
                connectorBindingId: "binding-1",
                metadata: JSON.stringify({
                    schemaVersion: 2,
                    provider: "github",
                    bindingId: "binding-1",
                    resourceKind: "git-repository",
                    providerResourceId: "repo-1",
                    resourceDisplayName: "widgets",
                    path: "src/index.ts",
                    displayName: "index.ts",
                    versionId: "commit-main",
                    git: {
                        repositoryName: "widgets",
                        repositoryUrl: "https://github.com/acme/widgets.git",
                        commitSha: "commit-main",
                        branch: "main",
                        defaultBranch: "main",
                    },
                }),
            },
            {
                id: "file-feature",
                name: "widgets/src/feature.ts",
                key: "key-connector-feature",
                storageKind: "internal",
                externalUrl: null,
                externalProvider: null,
                connectorBindingId: "binding-1",
                metadata: JSON.stringify({
                    schemaVersion: 2,
                    provider: "github",
                    bindingId: "binding-1",
                    resourceKind: "git-repository",
                    providerResourceId: "repo-1",
                    resourceDisplayName: "widgets",
                    path: "src/feature.ts",
                    displayName: "feature.ts",
                    versionId: "commit-feature",
                    git: {
                        repositoryName: "widgets",
                        repositoryUrl: "https://github.com/acme/widgets.git",
                        commitSha: "commit-feature",
                        branch: "feature",
                        defaultBranch: "main",
                    },
                }),
            },
        ];
        selectedFileIds = ["file-feature"];

        const contexts = await runWorkerTestEffect(
            loadCodeRepositoryContextsByBranch({ graphId: "graph-1", fileIds: selectedFileIds })
        );

        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.branch).toBe("feature");
        expect(contexts[0]?.isDefaultBranch).toBe(false);
        expect(contexts[0]?.files.map((file) => file.fileId)).toEqual(["file-feature"]);
    });

    test("includes external GitHub files from the same repository commit", async () => {
        rows = [
            ...baseRows,
            {
                id: "file-external",
                name: "widgets/src/external.ts",
                key: "external:github:acme/widgets@commit-1:src/external.ts",
                storageKind: "external",
                externalUrl: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/external.ts",
                externalProvider: "github",
                connectorBindingId: null,
                metadata: JSON.stringify({
                    repositoryUrl: "https://github.com/acme/widgets.git",
                    repositoryName: "widgets",
                    commitSha: "commit-1",
                    path: "src/external.ts",
                }),
            },
        ];
        globalThis.fetch = (async () =>
            new Response("export const external = true;\n", {
                headers: { "content-type": "text/plain" },
            })) as unknown as typeof fetch;

        const key = await runWorkerTestEffect(
            prepareCodeManifest({ graphId: "graph-1", fileIds: ["file-new"], processRunId: "run-1" })
        );

        expect(key).toBe("manifest-key");
        expect((uploadedManifest as { files: Array<{ path: string }> }).files.map((file) => file.path).sort()).toEqual([
            "src/external.ts",
            "src/helper.ts",
            "src/index.ts",
        ]);
    });
});

describe("readFileContentSource", () => {
    test("reads internal S3 content", async () => {
        await expect(runWorkerTestEffect(readFileContentSource({ kind: "internal", key: "key-new" }))).resolves.toBe(
            "import { helper } from '../../__tests__/helper';\nexport function main() { return helper(); }\n"
        );
    });

    test("fetches external GitHub raw content", async () => {
        globalThis.fetch = (async () =>
            new Response("export const value = 1;\n", {
                headers: { "content-type": "text/plain" },
            })) as unknown as typeof fetch;

        await expect(
            runWorkerTestEffect(
                readFileContentSource({
                    kind: "external",
                    provider: "github",
                    url: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
                })
            )
        ).resolves.toBe("export const value = 1;\n");
    });

    test("rejects non-GitHub external URLs before fetching", async () => {
        let fetched = false;
        globalThis.fetch = (async () => {
            fetched = true;
            return new Response("nope");
        }) as unknown as typeof fetch;

        await expect(
            runWorkerTestEffect(
                readFileContentSource({
                    kind: "external",
                    provider: "github",
                    url: "https://example.com/acme/widgets/commit-1/src/index.ts",
                })
            )
        ).rejects.toThrow("Unsupported external file source");
        expect(fetched).toBe(false);
    });

    test("rejects oversized external responses", async () => {
        globalThis.fetch = (async () =>
            new Response("too large", {
                headers: {
                    "content-type": "text/plain",
                    "content-length": String(2 * 1024 * 1024 + 1),
                },
            })) as unknown as typeof fetch;

        await expect(
            runWorkerTestEffect(
                readFileContentSource({
                    kind: "external",
                    provider: "github",
                    url: "https://raw.githubusercontent.com/acme/widgets/commit-1/src/index.ts",
                })
            )
        ).rejects.toThrow("too large");
    });
});
