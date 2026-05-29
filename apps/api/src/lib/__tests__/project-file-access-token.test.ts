import { describe, expect, mock, test } from "bun:test";

mock.module("../../env", () => ({
    env: {
        AUTH_SECRET: "test-project-file-access-token-secret",
        DATABASE_DIRECT_URL: "postgres://test:test@localhost:5432/test",
        S3_ACCESS_KEY_ID: "test",
        S3_SECRET_ACCESS_KEY: "test",
        S3_ENDPOINT: "http://localhost:9000",
        S3_REGION: "test",
        S3_BUCKET: "test",
        CONTEXT_WINDOW: 250_000,
        AI_TEXT_ADAPTER: "openai",
        AI_TEXT_MODEL: "test",
        AI_TEXT_KEY: "test",
        AI_EMBEDDING_ADAPTER: "openai",
        AI_EMBEDDING_MODEL: "test",
        AI_EMBEDDING_KEY: "test",
    },
}));

const {
    createProjectFileAccessToken,
    importProjectFileAccessTokenSigningKey,
    verifyProjectFileAccessToken,
} = await import("../project-file-access-token");

describe("project file access tokens", () => {
    test("surfaces HMAC key import failures instead of changing key derivation", async () => {
        await expect(
            importProjectFileAccessTokenSigningKey("secret", {
                importKey: async () => {
                    throw new Error("import failed");
                },
            })
        ).rejects.toThrow("Failed to import AUTH_SECRET as an HMAC signing key");
    });

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
