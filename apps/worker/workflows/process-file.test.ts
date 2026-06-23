import { describe, expect, test } from "bun:test";

process.env.AUTH_SECRET = "test-secret";
process.env.S3_ACCESS_KEY_ID = "test-access-key";
process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";
process.env.S3_ENDPOINT = "http://localhost:9000";
process.env.S3_REGION = "us-east-1";
process.env.S3_BUCKET = "test-bucket";
process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/kiwi";
process.env.DATABASE_DIRECT_URL = "postgres://user:pass@localhost:5432/kiwi";

// Dynamic import is required so this test can seed worker env vars before env.ts is evaluated.
const { fileProcessingWorkflow, shouldAbortRepositoryBatch, shouldFinalizeRepositoryBatch } =
    await import("./process-file");
const { allSettledWithConcurrency } = await import("./process-descriptions-group");
const { resolveRepositoryFinalizationTargets } = await import("../lib/code/repository-finalizer");

describe("fileProcessingWorkflow", () => {
    test("routes mixed batch children by stored file type", () => {
        const codeWorkflow = fileProcessingWorkflow("graph-1", "code-file", "code", "manifest-key");
        const textWorkflow = fileProcessingWorkflow("graph-1", "text-file", "text", "manifest-key");

        expect(codeWorkflow.spec.name).toBe("process-code-file");
        expect(codeWorkflow.input).toEqual({
            graphId: "graph-1",
            fileId: "code-file",
            codeManifestKey: "manifest-key",
        });
        expect(textWorkflow.spec.name).toBe("process-file");
        expect(textWorkflow.input).toEqual({
            graphId: "graph-1",
            fileId: "text-file",
        });
    });
});

describe("allSettledWithConcurrency", () => {
    test("limits active work and preserves all-settled results", async () => {
        let active = 0;
        let maxActive = 0;

        const results = await allSettledWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active -= 1;

            if (item === 4) {
                throw new Error("child failed");
            }

            return item * 2;
        });

        expect(maxActive).toBeLessThanOrEqual(2);
        expect(results.map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
            "fulfilled",
            "rejected",
            "fulfilled",
        ]);
        expect(results[0]).toEqual({ status: "fulfilled", value: 2 });
        expect((results[3] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    });
});

describe("repository batch guards", () => {
    test("finalizes repository batches only after every child workflow succeeds", () => {
        expect(
            shouldFinalizeRepositoryBatch({ kind: "repository", retiredFileIds: ["old-file"] }, [
                { status: "fulfilled", value: undefined },
            ])
        ).toBe(true);
        expect(shouldFinalizeRepositoryBatch({ kind: "repository", retiredFileIds: ["old-file"] }, [])).toBe(true);
        expect(
            shouldFinalizeRepositoryBatch({ kind: "repository", retiredFileIds: ["old-file"] }, [
                { status: "fulfilled", value: undefined },
                { status: "rejected", reason: new Error("failed") },
            ])
        ).toBe(false);
        expect(shouldFinalizeRepositoryBatch(undefined, [{ status: "fulfilled", value: undefined }])).toBe(false);
    });

    test("aborts incremental repository batches when any child workflow fails", () => {
        expect(
            shouldAbortRepositoryBatch({ kind: "repository", retiredFileIds: [] }, [
                { status: "fulfilled", value: undefined },
                { status: "rejected", reason: new Error("failed") },
            ])
        ).toBe(true);
        expect(
            shouldAbortRepositoryBatch({ kind: "repository" }, [
                { status: "fulfilled", value: undefined },
                { status: "rejected", reason: new Error("failed") },
            ])
        ).toBe(false);
    });
});

describe("resolveRepositoryFinalizationTargets", () => {
    test("targets older files for the same repository URL and preserves other repositories", () => {
        const latestMetadata = JSON.stringify({
            repositoryUrl: "https://github.com/acme/widgets.git",
            repositoryName: "widgets",
            commitSha: "commit-2",
            path: "src/index.ts",
        });
        const oldMetadata = JSON.stringify({
            repositoryUrl: "https://github.com/acme/widgets.git",
            repositoryName: "widgets",
            commitSha: "commit-1",
            path: "src/removed.ts",
        });
        const otherMetadata = JSON.stringify({
            repositoryUrl: "https://github.com/acme/other.git",
            repositoryName: "other",
            commitSha: "commit-1",
            path: "src/index.ts",
        });

        expect(
            resolveRepositoryFinalizationTargets(
                [{ id: "new-file", metadata: latestMetadata }],
                [
                    { id: "new-file", metadata: latestMetadata },
                    { id: "old-file", metadata: oldMetadata },
                    { id: "other-file", metadata: otherMetadata },
                ]
            )
        ).toEqual({
            repositoryUrls: ["https://github.com/acme/widgets.git"],
            olderFileIds: ["old-file"],
        });
    });
});
