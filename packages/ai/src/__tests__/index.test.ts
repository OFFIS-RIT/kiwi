import { describe, expect, mock, test } from "bun:test";

mock.module("@kiwi/db", () => ({
    betterAuthDb: {},
    db: {},
}));

const { AI_REQUEST_TIMEOUT_MS, createProviderFetch, isSupportedTranscriptionAdapter, normalizeOptionalString } =
    await import("../index");

describe("AI config helpers", () => {
    test("normalizes optional strings", () => {
        expect(normalizeOptionalString(undefined)).toBeUndefined();
        expect(normalizeOptionalString(" \t ")).toBeUndefined();
        expect(normalizeOptionalString("  value  ")).toBe("value");
    });

    test("identifies supported transcription adapters", () => {
        expect(isSupportedTranscriptionAdapter("openai")).toBe(true);
        expect(isSupportedTranscriptionAdapter("azure")).toBe(true);
        expect(isSupportedTranscriptionAdapter("openaiAPI")).toBe(true);
        expect(isSupportedTranscriptionAdapter("anthropic")).toBe(false);
    });
});

describe("createProviderFetch", () => {
    test("applies the shared request timeout", async () => {
        let capturedInit: RequestInit | undefined;

        const providerFetch = createProviderFetch(async (_input, init) => {
            capturedInit = init;
            return new Response("ok");
        });

        await providerFetch("https://example.com", {
            headers: { "x-test": "1" },
        });

        expect(capturedInit).toBeDefined();
        expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
        expect(capturedInit?.signal?.aborted).toBe(false);
        expect(AI_REQUEST_TIMEOUT_MS).toBe(90 * 60 * 1000);
    });

    test("propagates caller aborts through the merged signal", async () => {
        let capturedSignal: AbortSignal | undefined;

        const providerFetch = createProviderFetch(async (_input, init) => {
            capturedSignal = init?.signal ?? undefined;
            return new Response("ok");
        });

        const controller = new AbortController();
        await providerFetch("https://example.com", { signal: controller.signal });

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal).not.toBe(controller.signal);
        expect(capturedSignal?.aborted).toBe(false);

        controller.abort(new Error("boom"));

        expect(capturedSignal?.aborted).toBe(true);
        expect(capturedSignal?.reason).toEqual(controller.signal.reason);
    });
});
