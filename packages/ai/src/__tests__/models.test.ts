import { describe, expect, mock, test } from "bun:test";
import { API_ERROR_CODES } from "@kiwi/contracts/responses";

mock.module("@kiwi/db", () => ({
    db: {},
}));

const {
    allocateUniqueModelId,
    assertValidModelConfiguration,
    decryptModelCredentials,
    encryptModelCredentials,
    normalizeModelId,
} = await import("../models");

describe("AI model registry helpers", () => {
    test("normalizes model IDs to stable slugs", () => {
        expect(normalizeModelId(" GPT 5.5 ")).toBe("gpt-5.5");
        expect(normalizeModelId("claude_sonnet/4")).toBe("claude_sonnet-4");
        expect(normalizeModelId(" ")).toBe("model");
    });

    test("allocates duplicate model IDs with numeric suffixes", async () => {
        const existing = new Set(["gpt-5.5", "gpt-5.5-1"]);

        await expect(allocateUniqueModelId("gpt-5.5", async (candidate) => existing.has(candidate))).resolves.toBe(
            "gpt-5.5-2"
        );
    });

    test("encrypts credentials without storing plaintext and decrypts with the same secret", () => {
        const credentials = {
            apiKey: "secret-key",
            url: "https://example.test/v1",
        };
        const encrypted = encryptModelCredentials(credentials, "test-auth-secret");

        expect(encrypted).not.toContain(credentials.apiKey);
        expect(decryptModelCredentials(encrypted, "test-auth-secret")).toEqual(credentials);
        expect(() => decryptModelCredentials(encrypted, "wrong-secret")).toThrow(API_ERROR_CODES.INVALID_MODEL);
    });

    test("rejects invalid model adapter and credential combinations", () => {
        expect(() =>
            assertValidModelConfiguration({
                type: "embedding",
                adapter: "anthropic",
                providerModel: "claude-test",
                credentials: { apiKey: "key" },
            })
        ).toThrow(API_ERROR_CODES.INVALID_MODEL);

        expect(() =>
            assertValidModelConfiguration({
                type: "text",
                adapter: "openaiAPI",
                providerModel: "gpt-test",
                credentials: { apiKey: "key" },
            })
        ).toThrow(API_ERROR_CODES.INVALID_MODEL);

        expect(() =>
            assertValidModelConfiguration({
                type: "text",
                adapter: "openai",
                providerModel: "gpt-test",
                credentials: { apiKey: "key" },
            })
        ).not.toThrow();
    });
});
