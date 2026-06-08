import { describe, expect, mock, test } from "bun:test";

const envMock = {
    AI_TEXT_ADAPTER: "openai",
    AI_TEXT_MODEL: "gpt-test",
    AI_TEXT_KEY: "text-key",
    AI_TEXT_URL: undefined,
    AI_TEXT_RESOURCE_NAME: undefined,
    AI_EXTRACT_ADAPTER: undefined,
    AI_EXTRACT_MODEL: undefined,
    AI_EXTRACT_KEY: undefined,
    AI_EXTRACT_URL: undefined,
    AI_EXTRACT_RESOURCE_NAME: undefined,
    AI_AUDIO_ADAPTER: undefined as "openai" | "azure" | "anthropic" | "openaiAPI" | undefined,
    AI_AUDIO_MODEL: undefined as string | undefined,
    AI_AUDIO_KEY: undefined as string | undefined,
    AI_AUDIO_URL: undefined as string | undefined,
    AI_AUDIO_RESOURCE_NAME: undefined as string | undefined,
    AI_VIDEO_ADAPTER: undefined as "openai" | "azure" | "anthropic" | "openaiAPI" | undefined,
    AI_VIDEO_MODEL: undefined as string | undefined,
    AI_VIDEO_KEY: undefined as string | undefined,
    AI_VIDEO_URL: undefined as string | undefined,
    AI_VIDEO_RESOURCE_NAME: undefined as string | undefined,
};

mock.module("../../env", () => ({
    env: envMock,
}));

mock.module("@kiwi/ai", () => ({
    buildAdapter: (
        type: typeof envMock.AI_AUDIO_ADAPTER,
        model: string,
        apiKey: string,
        url?: string,
        resourceName?: string
    ) => ({
        type,
        model,
        credentials: {
            apiKey,
            ...(url ? { url } : {}),
            ...(resourceName ? { resourceName } : {}),
        },
    }),
    buildEmbeddingAdapter: mock(() => undefined),
}));

const { buildAudioAdapter } = await import("../ai");
const { buildVideoAdapter } = await import("../ai");

describe("buildAudioAdapter", () => {
    test("returns undefined when optional audio config is absent", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: undefined,
            AI_AUDIO_MODEL: undefined,
            AI_AUDIO_KEY: undefined,
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
        });
        expect(buildAudioAdapter()).toBeUndefined();

        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "" as never,
            AI_AUDIO_MODEL: "",
            AI_AUDIO_KEY: "",
            AI_AUDIO_URL: "",
            AI_AUDIO_RESOURCE_NAME: "",
        });
        expect(buildAudioAdapter()).toBeUndefined();

        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: " " as never,
            AI_AUDIO_MODEL: " ",
            AI_AUDIO_KEY: "\t",
            AI_AUDIO_URL: " ",
            AI_AUDIO_RESOURCE_NAME: " ",
        });
        expect(buildAudioAdapter()).toBeUndefined();
    });

    test("throws when optional audio config is incomplete", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "openai",
            AI_AUDIO_MODEL: "gpt-4o-mini-transcribe",
            AI_AUDIO_KEY: undefined,
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
        });
        expect(() => buildAudioAdapter()).toThrow(
            "AI_AUDIO_ADAPTER, AI_AUDIO_MODEL, and AI_AUDIO_KEY must be set together"
        );

        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "openaiAPI",
            AI_AUDIO_MODEL: "openai/whisper-1",
            AI_AUDIO_KEY: "audio-key",
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
        });
        expect(() => buildAudioAdapter()).toThrow("AI_AUDIO_URL is required when AI_AUDIO_ADAPTER is openaiAPI");

        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "azure",
            AI_AUDIO_MODEL: "gpt-4o-transcribe",
            AI_AUDIO_KEY: "audio-key",
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
        });
        expect(() => buildAudioAdapter()).toThrow("AI_AUDIO_RESOURCE_NAME is required when AI_AUDIO_ADAPTER is azure");

        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "anthropic",
            AI_AUDIO_MODEL: "claude-sonnet-4-5",
            AI_AUDIO_KEY: "audio-key",
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
        });
        expect(() => buildAudioAdapter()).toThrow("AI_AUDIO_ADAPTER=anthropic is not supported for transcription");

        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "custom" as never,
            AI_AUDIO_MODEL: "transcribe",
            AI_AUDIO_KEY: "audio-key",
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
        });
        expect(() => buildAudioAdapter()).toThrow("AI_AUDIO_ADAPTER=custom is not supported for transcription");
    });

    test("builds OpenAI-compatible audio adapter when optional audio config is complete", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "openaiAPI",
            AI_AUDIO_MODEL: "openai/whisper-1",
            AI_AUDIO_KEY: "audio-key",
            AI_AUDIO_URL: "https://openrouter.ai/api/v1",
            AI_AUDIO_RESOURCE_NAME: undefined,
        });

        expect(buildAudioAdapter()).toEqual({
            type: "openaiAPI",
            model: "openai/whisper-1",
            credentials: {
                apiKey: "audio-key",
                url: "https://openrouter.ai/api/v1",
            },
        });
    });

    test("builds OpenAI and Azure audio adapters with their required credentials", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "openai",
            AI_AUDIO_MODEL: "gpt-4o-mini-transcribe",
            AI_AUDIO_KEY: "audio-key",
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
        });
        expect(buildAudioAdapter()).toEqual({
            type: "openai",
            model: "gpt-4o-mini-transcribe",
            credentials: {
                apiKey: "audio-key",
            },
        });

        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "azure",
            AI_AUDIO_MODEL: "gpt-4o-transcribe",
            AI_AUDIO_KEY: "azure-key",
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: "speech-resource",
        });
        expect(buildAudioAdapter()).toEqual({
            type: "azure",
            model: "gpt-4o-transcribe",
            credentials: {
                apiKey: "azure-key",
                resourceName: "speech-resource",
            },
        });
    });
});

describe("buildVideoAdapter", () => {
    test("returns undefined when optional video config is absent", () => {
        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: undefined,
            AI_VIDEO_MODEL: undefined,
            AI_VIDEO_KEY: undefined,
            AI_VIDEO_URL: undefined,
            AI_VIDEO_RESOURCE_NAME: undefined,
        });
        expect(buildVideoAdapter()).toBeUndefined();

        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: "" as never,
            AI_VIDEO_MODEL: "",
            AI_VIDEO_KEY: "",
            AI_VIDEO_URL: "",
            AI_VIDEO_RESOURCE_NAME: "",
        });
        expect(buildVideoAdapter()).toBeUndefined();

        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: " " as never,
            AI_VIDEO_MODEL: " ",
            AI_VIDEO_KEY: "\t",
            AI_VIDEO_URL: " ",
            AI_VIDEO_RESOURCE_NAME: " ",
        });
        expect(buildVideoAdapter()).toBeUndefined();
    });

    test("throws when optional video config is incomplete", () => {
        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: "openai",
            AI_VIDEO_MODEL: "gpt-4o-mini-transcribe",
            AI_VIDEO_KEY: undefined,
            AI_VIDEO_URL: undefined,
            AI_VIDEO_RESOURCE_NAME: undefined,
        });
        expect(() => buildVideoAdapter()).toThrow(
            "AI_VIDEO_ADAPTER, AI_VIDEO_MODEL, and AI_VIDEO_KEY must be set together"
        );

        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: "openaiAPI",
            AI_VIDEO_MODEL: "openai/whisper-1",
            AI_VIDEO_KEY: "video-key",
            AI_VIDEO_URL: undefined,
            AI_VIDEO_RESOURCE_NAME: undefined,
        });
        expect(() => buildVideoAdapter()).toThrow("AI_VIDEO_URL is required when AI_VIDEO_ADAPTER is openaiAPI");

        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: "anthropic",
            AI_VIDEO_MODEL: "claude-sonnet-4-5",
            AI_VIDEO_KEY: "video-key",
            AI_VIDEO_URL: undefined,
            AI_VIDEO_RESOURCE_NAME: undefined,
        });
        expect(() => buildVideoAdapter()).toThrow("AI_VIDEO_ADAPTER=anthropic is not supported for transcription");

        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: "custom" as never,
            AI_VIDEO_MODEL: "transcribe",
            AI_VIDEO_KEY: "video-key",
            AI_VIDEO_URL: undefined,
            AI_VIDEO_RESOURCE_NAME: undefined,
        });
        expect(() => buildVideoAdapter()).toThrow("AI_VIDEO_ADAPTER=custom is not supported for transcription");
    });

    test("builds a video adapter when optional video config is complete", () => {
        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: "openaiAPI",
            AI_VIDEO_MODEL: "openai/whisper-1",
            AI_VIDEO_KEY: "video-key",
            AI_VIDEO_URL: "https://openrouter.ai/api/v1",
            AI_VIDEO_RESOURCE_NAME: undefined,
        });

        expect(buildVideoAdapter()).toEqual({
            type: "openaiAPI",
            model: "openai/whisper-1",
            credentials: {
                apiKey: "video-key",
                url: "https://openrouter.ai/api/v1",
            },
        });
    });
});
