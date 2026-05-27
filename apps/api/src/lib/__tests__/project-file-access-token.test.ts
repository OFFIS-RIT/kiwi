import { describe, expect, test } from "bun:test";

process.env.AUTH_SECRET ??= "test-project-file-access-token-secret";
process.env.DATABASE_DIRECT_URL ??= "postgres://test:test@localhost:5432/test";
process.env.S3_ACCESS_KEY_ID ??= "test";
process.env.S3_SECRET_ACCESS_KEY ??= "test";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_REGION ??= "test";
process.env.S3_BUCKET ??= "test";
process.env.AI_TEXT_ADAPTER ??= "openai";
process.env.AI_TEXT_MODEL ??= "test";
process.env.AI_TEXT_KEY ??= "test";
process.env.AI_EMBEDDING_ADAPTER ??= "openai";
process.env.AI_EMBEDDING_MODEL ??= "test";
process.env.AI_EMBEDDING_KEY ??= "test";

const { createProjectFileAccessToken, verifyProjectFileAccessToken } = await import("../project-file-access-token");

describe("project file access tokens", () => {
    test("creates tokens bound to a graph and file", async () => {
        const now = new Date("2026-01-01T00:00:00Z");
        const token = await createProjectFileAccessToken("graph-1", "file-1", { now, expiresInSeconds: 60 });

        await expect(verifyProjectFileAccessToken(token, "graph-1", "file-1", { now })).resolves.toBe(true);
        await expect(verifyProjectFileAccessToken(token, "graph-2", "file-1", { now })).resolves.toBe(false);
        await expect(verifyProjectFileAccessToken(token, "graph-1", "file-2", { now })).resolves.toBe(false);
    });

    test("rejects expired and tampered tokens", async () => {
        const token = await createProjectFileAccessToken("graph-1", "file-1", {
            now: new Date("2026-01-01T00:00:00Z"),
            expiresInSeconds: 60,
        });

        await expect(
            verifyProjectFileAccessToken(token, "graph-1", "file-1", { now: new Date("2026-01-01T00:02:00Z") })
        ).resolves.toBe(false);
        await expect(verifyProjectFileAccessToken(`${token}x`, "graph-1", "file-1")).resolves.toBe(false);
    });
});
