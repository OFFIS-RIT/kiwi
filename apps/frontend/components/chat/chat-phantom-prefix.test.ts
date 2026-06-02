import { describe, expect, it } from "vitest";

import type { ChatUIMessage } from "@kiwi/ai/ui";
import { stripPhantomPrefix } from "./chat-phantom-prefix";

const clarificationPart = {
    type: "tool-ask_clarifying_questions",
    toolCallId: "tool-1",
    state: "output-available",
    input: { questions: ["Which scope?"] },
    output: { answers: ["The PDF"] },
} as const;

describe("stripPhantomPrefix", () => {
    it("removes cloned previous metadata from auto-continued assistant streams", () => {
        const previous: ChatUIMessage = {
            id: "assistant-1",
            role: "assistant",
            parts: [clarificationPart],
            metadata: {
                createdAt: "2026-06-02T10:00:00.000Z",
                modelId: "model",
                durationMs: 19_000,
                totalTokens: 42,
            },
        };
        const next: ChatUIMessage = {
            ...previous,
            id: "assistant-2",
            parts: [...previous.parts, { type: "text", text: "Checking now." }],
        };

        const stripped = stripPhantomPrefix([previous, next]);

        expect(stripped[1]).toMatchObject({
            id: "assistant-2",
            parts: [{ type: "text", text: "Checking now." }],
        });
        expect(stripped[1]?.metadata).toBeUndefined();
    });

    it("removes stale finish metrics while preserving live start metadata", () => {
        const previous: ChatUIMessage = {
            id: "assistant-1",
            role: "assistant",
            parts: [clarificationPart],
            metadata: {
                createdAt: "2026-06-02T10:00:00.000Z",
                modelId: "model",
                durationMs: 19_000,
                totalTokens: 42,
                tokensPerSecond: 2.2,
            },
        };
        const next: ChatUIMessage = {
            id: "assistant-2",
            role: "assistant",
            parts: [...previous.parts, { type: "text", text: "Checking now." }],
            metadata: {
                ...previous.metadata,
                createdAt: "2026-06-02T10:00:19.000Z",
            },
        };

        const stripped = stripPhantomPrefix([previous, next]);

        expect(stripped[1]?.metadata).toEqual({
            createdAt: "2026-06-02T10:00:19.000Z",
            modelId: "model",
        });
    });

    it("keeps fresh final metadata for a completed follow-up message", () => {
        const previous: ChatUIMessage = {
            id: "assistant-1",
            role: "assistant",
            parts: [clarificationPart],
            metadata: { durationMs: 19_000 },
        };
        const next: ChatUIMessage = {
            id: "assistant-2",
            role: "assistant",
            parts: [...previous.parts, { type: "text", text: "Done." }],
            metadata: { durationMs: 3_000, totalTokens: 12 },
        };

        const stripped = stripPhantomPrefix([previous, next]);

        expect(stripped[1]?.metadata).toEqual({ durationMs: 3_000, totalTokens: 12 });
    });
});
