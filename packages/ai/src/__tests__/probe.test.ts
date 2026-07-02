import { describe, expect, mock, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";

const generateTextMock = mock(async () => ({ text: "" }));
const embedMock = mock(async () => ({ embedding: [0] }));

// Covers every runtime export the ../probe import chain pulls from "ai".
mock.module("ai", () => ({
    generateText: generateTextMock,
    embed: embedMock,
    isStepCount: () => Symbol("stop"),
    ToolLoopAgent: class {
        generate = mock(async () => ({ text: "" }));
    },
    tool: <T extends Record<string, unknown>>(definition: T) => definition,
}));

mock.module("@kiwi/db", () => ({
    db: {},
}));

const { buildProbeWav, classifyModelProbeError, probeModelConfiguration } = await import("../probe");

function apiCallError(options: { statusCode?: number; responseBody?: string; message?: string; cause?: unknown }) {
    return new APICallError({
        message: options.message ?? "request failed",
        url: "https://provider.example/v1/chat/completions",
        requestBodyValues: {},
        statusCode: options.statusCode,
        responseBody: options.responseBody,
        cause: options.cause,
    });
}

const TEXT_PROBE_INPUT = {
    type: "text",
    adapter: "openai",
    providerModel: "test-model",
    credentials: { apiKey: "test-key" },
} as const;

describe("classifyModelProbeError", () => {
    test("classifies 401 and 403 as auth", () => {
        expect(classifyModelProbeError(apiCallError({ statusCode: 401 })).reason).toBe("auth");
        expect(classifyModelProbeError(apiCallError({ statusCode: 403 })).reason).toBe("auth");
    });

    test("classifies 404 as not_found", () => {
        expect(classifyModelProbeError(apiCallError({ statusCode: 404 })).reason).toBe("not_found");
    });

    test("classifies other status codes as unknown", () => {
        expect(classifyModelProbeError(apiCallError({ statusCode: 429 })).reason).toBe("unknown");
        expect(classifyModelProbeError(apiCallError({ statusCode: 500 })).reason).toBe("unknown");
    });

    test("classifies APICallError without status code as unreachable", () => {
        const error = apiCallError({ message: "Cannot connect to API: fetch failed" });
        expect(classifyModelProbeError(error).reason).toBe("unreachable");
    });

    test("classifies timeouts and network failures as unreachable", () => {
        expect(classifyModelProbeError(new DOMException("timed out", "TimeoutError")).reason).toBe("unreachable");
        expect(classifyModelProbeError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })).reason).toBe(
            "unreachable"
        );
        expect(classifyModelProbeError(new Error("getaddrinfo failed", { cause: { code: "ENOTFOUND" } })).reason).toBe(
            "unreachable"
        );
    });

    test("extracts status codes from transcription request errors", () => {
        const error = new Error(
            'OpenAI-compatible transcription request failed (401 Unauthorized): {"error":"invalid key"}'
        );
        expect(classifyModelProbeError(error).reason).toBe("auth");
    });

    test("prefers the provider message from the response body", () => {
        const result = classifyModelProbeError(
            apiCallError({
                statusCode: 404,
                responseBody: JSON.stringify({ error: { message: "The model `nope` does not exist" } }),
            })
        );
        expect(result.message).toBe("The model `nope` does not exist");
    });

    test("truncates long messages", () => {
        const result = classifyModelProbeError(new Error("x".repeat(1_000)));
        expect(result.message.length).toBeLessThanOrEqual(300);
    });

    test("classifies unrecognized errors as unknown", () => {
        expect(classifyModelProbeError(new Error("something odd")).reason).toBe("unknown");
    });
});

describe("probeModelConfiguration", () => {
    test("reports success when the text probe request succeeds", async () => {
        generateTextMock.mockClear();
        generateTextMock.mockResolvedValueOnce({ text: "pong" });

        const result = await probeModelConfiguration(TEXT_PROBE_INPUT);

        expect(result).toEqual({ ok: true });
        expect(generateTextMock).toHaveBeenCalledTimes(1);
    });

    test("classifies provider failures instead of throwing", async () => {
        generateTextMock.mockRejectedValueOnce(apiCallError({ statusCode: 401 }));

        const result = await probeModelConfiguration(TEXT_PROBE_INPUT);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("auth");
        }
    });

    test("embeds a test string for embedding models", async () => {
        embedMock.mockClear();

        const result = await probeModelConfiguration({
            type: "embedding",
            adapter: "openaiAPI",
            providerModel: "test-embedding",
            credentials: { apiKey: "test-key", url: "https://provider.example/v1" },
        });

        expect(result).toEqual({ ok: true });
        expect(embedMock).toHaveBeenCalledTimes(1);
    });
});

describe("buildProbeWav", () => {
    test("produces a valid non-empty WAV payload", () => {
        const wav = buildProbeWav();
        const view = new DataView(wav.buffer);

        expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
        expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
        // Declared data size matches the payload after the 44-byte header.
        expect(view.getUint32(40, true)).toBe(wav.byteLength - 44);
        expect(wav.byteLength).toBeGreaterThan(44);
    });
});
