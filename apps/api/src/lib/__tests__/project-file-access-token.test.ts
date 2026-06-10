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
    },
}));

const {
    createProjectFileAccessToken,
    importProjectFileAccessTokenSigningKey,
    verifyProjectFileAccessToken,
} = await import("../project-file-access-token");

const testSecret = "test-project-file-access-token-secret";
const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function createLegacyRawSecretToken(payload: { graphId: string; fileId: string; exp: number }) {
    const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(testSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(encodedPayload));

    return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

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

    test("verifies tokens signed with legacy raw AUTH_SECRET bytes", async () => {
        const now = new Date("2026-01-01T00:00:00Z");
        const token = await createLegacyRawSecretToken({
            graphId: "graph-1",
            fileId: "file-1",
            exp: Math.floor(now.getTime() / 1000) + 60,
        });

        await expect(verifyProjectFileAccessToken(token, "graph-1", "file-1", { now })).resolves.toBe(true);
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
