import { describe, expect, mock, test } from "bun:test";
import { API_ERROR_CODES } from "@kiwi/contracts/responses";
import type { AiModel, AiModelAdapter, AiModelType } from "@kiwi/db/tables/models";

let queuedModelRows: unknown[][] = [];
const selectMock = mock(() => ({
    from: () => ({
        where: () => ({
            limit: async () => queuedModelRows.shift() ?? [],
        }),
    }),
}));

mock.module("@kiwi/db", () => ({
    db: {
        select: selectMock,
    },
}));

const {
    allocateUniqueModelId,
    assertValidModelConfiguration,
    collectLegacyModelSeeds,
    decryptModelCredentials,
    encryptModelCredentials,
    normalizeModelId,
    resolveResearchModelConfig,
    resolveWorkerModelConfig,
} = await import("../models");

const TEST_SECRET = "test-auth-secret";

function queueModelQueries(...rows: unknown[][]) {
    queuedModelRows = [...rows];
    selectMock.mockClear();
}

function createModelRow(options: {
    type: AiModelType;
    modelId: string;
    providerModel: string;
    adapter?: AiModelAdapter;
}): AiModel {
    return {
        id: `${options.type}-${options.modelId}`,
        organizationId: "org-1",
        modelId: options.modelId,
        displayName: options.modelId,
        type: options.type,
        adapter: options.adapter ?? "openai",
        providerModel: options.providerModel,
        encryptedCredentials: encryptModelCredentials({ apiKey: "model-key" }, TEST_SECRET),
        isDefault: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
}

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

    test("collects complete legacy env model seeds and skips invalid optional media config", () => {
        const seeds = collectLegacyModelSeeds({
            AI_TEXT_ADAPTER: "openai",
            AI_TEXT_MODEL: "gpt-test",
            AI_TEXT_KEY: "text-key",
            AI_SUBAGENT_MODEL: "gpt-subagent",
            AI_EXTRACT_ADAPTER: "openai",
            AI_EXTRACT_MODEL: "gpt-extract",
            AI_EXTRACT_KEY: "extract-key",
            AI_EMBEDDING_ADAPTER: "openai",
            AI_EMBEDDING_MODEL: "text-embedding-test",
            AI_EMBEDDING_KEY: "embedding-key",
            AI_AUDIO_ADAPTER: "openaiAPI",
            AI_AUDIO_MODEL: "transcribe-test",
            AI_AUDIO_KEY: "audio-key",
            AI_AUDIO_URL: "https://example.test/v1",
            AI_VIDEO_ADAPTER: "anthropic",
            AI_VIDEO_MODEL: "claude-test",
            AI_VIDEO_KEY: "video-key",
        });

        expect(seeds.map((seed) => seed.type)).toEqual(["text", "embedding", "extract", "audio", "subagent"]);
        expect(seeds.find((seed) => seed.type === "text")?.modelId).toBe("gpt-test");
        expect(seeds.find((seed) => seed.type === "embedding")?.modelId).toBe("embedding-text-embedding-test");
        expect(seeds.find((seed) => seed.type === "audio")?.credentials).toEqual({
            apiKey: "audio-key",
            url: "https://example.test/v1",
        });
    });

    test("rejects unknown requested text models instead of falling back to the default", async () => {
        const embeddingModel = createModelRow({
            type: "embedding",
            modelId: "embedding-default",
            providerModel: "text-embedding-test",
        });

        queueModelQueries([], [embeddingModel], []);

        await expect(
            resolveResearchModelConfig({
                organizationId: "org-1",
                requestedTextModelId: "missing-model",
                secret: TEST_SECRET,
            })
        ).rejects.toThrow(API_ERROR_CODES.INVALID_MODEL);
        expect(selectMock).toHaveBeenCalledTimes(3);
    });

    test("resolves worker models from extract and embedding defaults without requiring a text fallback", async () => {
        const extractModel = createModelRow({
            type: "extract",
            modelId: "extract-default",
            providerModel: "gpt-extract",
        });
        const embeddingModel = createModelRow({
            type: "embedding",
            modelId: "embedding-default",
            providerModel: "text-embedding-test",
        });

        queueModelQueries([extractModel], [], [embeddingModel], [], [], []);

        const resolved = await resolveWorkerModelConfig({
            organizationId: "org-1",
            secret: TEST_SECRET,
        });

        expect(resolved.config.text).toMatchObject({ type: "openai", model: "gpt-extract" });
        expect(resolved.config.embedding).toMatchObject({ type: "openai", model: "text-embedding-test" });
        expect(selectMock).toHaveBeenCalledTimes(6);
    });
});
