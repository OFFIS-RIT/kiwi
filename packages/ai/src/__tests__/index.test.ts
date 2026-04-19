import { describe, expect, test } from "bun:test";

import { AI_REQUEST_TIMEOUT_MS, createProviderFetch } from "../index";

describe("createProviderFetch", () => {
    test("disables Bun's default timeout and applies the shared request timeout", async () => {
        let capturedInit: (RequestInit & { timeout?: false }) | undefined;

        const providerFetch = createProviderFetch(async (_input, init) => {
            capturedInit = init as RequestInit & { timeout?: false };
            return new Response("ok");
        });

        await providerFetch("https://example.com", {
            headers: { "x-test": "1" },
        });

        expect(capturedInit).toBeDefined();
        expect(capturedInit?.timeout).toBe(false);
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
