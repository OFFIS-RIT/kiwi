import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
    decryptConnectorCredentials,
    decryptConnectorSecret,
    encryptConnectorCredentials,
    encryptConnectorSecret,
} from "../credentials";

const AUTH_SECRET = "unit-test-auth-secret";

describe("connector credentials", () => {
    test("round-trips connector credentials and webhook secrets", () => {
        const encrypted = encryptConnectorCredentials(
            {
                provider: "github",
                appId: "123",
                privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
                clientId: "client-id",
                clientSecret: "client-secret",
                webhookSecret: "webhook-secret",
            },
            AUTH_SECRET
        );

        expect(decryptConnectorCredentials(encrypted, AUTH_SECRET)).toEqual({
            provider: "github",
            appId: "123",
            privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
            clientId: "client-id",
            clientSecret: "client-secret",
            webhookSecret: "webhook-secret",
        });

        expect(decryptConnectorSecret(encryptConnectorSecret("hook", AUTH_SECRET), AUTH_SECRET)).toBe("hook");
    });

    test("rejects invalid versions and wrong secrets", () => {
        const encrypted = encryptConnectorCredentials({ provider: "gitlab", accessToken: "token" }, AUTH_SECRET);

        expect(() => decryptConnectorCredentials(encrypted.replace("v1:", "v0:"), AUTH_SECRET)).toThrow(
            "Invalid connector credentials"
        );
        expect(() => decryptConnectorCredentials(encrypted, "wrong-secret")).toThrow("Invalid connector credentials");
    });

    test("rejects invalid decrypted shapes", () => {
        const encrypted = encryptUnchecked({ provider: "github", appId: "123" }, AUTH_SECRET);

        expect(() => decryptConnectorCredentials(encrypted, AUTH_SECRET)).toThrow("Invalid connector credentials");
        expect(() =>
            encryptConnectorCredentials({ provider: "gitlab", accessToken: "" } as never, AUTH_SECRET)
        ).toThrow("Invalid connector credentials");
    });
});

function encryptUnchecked(value: unknown, secret: string): string {
    const iv = randomBytes(12);
    const key = Buffer.from(
        hkdfSync("sha256", secret, "kiwi-connector-credentials:v1", "connector-credential-encryption", 32)
    );
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
    return [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
    ].join(":");
}
