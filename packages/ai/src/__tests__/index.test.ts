import { describe, expect, test } from "bun:test";

import { AI_REQUEST_TIMEOUT, AI_REQUEST_TIMEOUT_MS, getProviderOptions } from "../index";

describe("AI config helpers", () => {
    test("omits provider-specific options when thinking is not configured", () => {
        expect(getProviderOptions({})).toBeUndefined();
    });

    test("maps thinking effort to each provider's v7 option shape", () => {
        expect(getProviderOptions({ thinking: "high" })).toEqual({
            openAI: {
                reasoningEffort: "high",
                parallelToolCalls: true,
            },
            anthropic: {
                thinking: {
                    type: "adaptive",
                },
                effort: "high",
                toolStreaming: true,
            },
            openaiAPI: {
                thinking: "high",
                parallelToolCalls: true,
            },
            azure: {
                reasoningEffort: "high",
                parallelToolCalls: true,
            },
        });
    });
});

describe("AI SDK timeout config", () => {
    test("exports the SDK total timeout used by AI calls", () => {
        expect(AI_REQUEST_TIMEOUT_MS).toBe(10 * 60 * 1000);
        expect(AI_REQUEST_TIMEOUT).toEqual({ totalMs: AI_REQUEST_TIMEOUT_MS });
    });
});
