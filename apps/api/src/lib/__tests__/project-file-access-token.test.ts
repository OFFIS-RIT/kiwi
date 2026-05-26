import { describe, expect, test } from "bun:test";
import { createProjectFileAccessToken, verifyProjectFileAccessToken } from "../project-file-access-token";

process.env.AUTH_SECRET ??= "test-project-file-access-token-secret";

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
