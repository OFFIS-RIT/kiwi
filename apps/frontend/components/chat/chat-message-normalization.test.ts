import type { ChatUIMessage } from "@kiwi/ai/ui";
import { describe, expect, it } from "vitest";

import { stripPhantomPrefix } from "./chat-message-normalization";

describe("chat message normalization", () => {
    it("strips cloned assistant parts and stale finish metadata from auto-continued streams", () => {
        const previousParts: ChatUIMessage["parts"] = [
            {
                type: "tool-ask_clarifying_questions",
                toolCallId: "tool-1",
                state: "output-available",
                input: { questions: ["Which measurement?"] },
                output: { answers: ["PICOScan"] },
            },
        ];
        const previous: ChatUIMessage = {
            id: "assistant-1",
            role: "assistant",
            parts: previousParts,
            metadata: {
                createdAt: "2026-06-05T10:00:00.000Z",
                durationMs: 10_000,
                totalTokens: 123,
                tokensPerSecond: 12.3,
                usedFileCount: 0,
            },
        };
        const next: ChatUIMessage = {
            id: "assistant-2",
            role: "assistant",
            parts: [...previousParts, { type: "text", text: "Continuing with the answer." }],
            metadata: {
                createdAt: "2026-06-05T10:00:00.000Z",
                durationMs: 10_000,
                totalTokens: 123,
                tokensPerSecond: 12.3,
                usedFileCount: 0,
            },
        };

        const normalized = stripPhantomPrefix([previous, next]);

        expect(normalized[1]?.parts).toEqual([{ type: "text", text: "Continuing with the answer." }]);
        expect(normalized[1]?.metadata).toBeUndefined();
    });

    it("keeps fresh start metadata while removing stale finish metrics", () => {
        const previousParts: ChatUIMessage["parts"] = [{ type: "text", text: "Earlier work." }];
        const previous: ChatUIMessage = {
            id: "assistant-1",
            role: "assistant",
            parts: previousParts,
            metadata: {
                createdAt: "2026-06-05T10:00:00.000Z",
                modelId: "model-a",
                durationMs: 10_000,
            },
        };
        const next: ChatUIMessage = {
            id: "assistant-2",
            role: "assistant",
            parts: [...previousParts, { type: "text", text: "Fresh stream." }],
            metadata: {
                createdAt: "2026-06-05T10:00:11.000Z",
                modelId: "model-a",
                durationMs: 10_000,
                totalTokens: 123,
            },
        };

        const normalized = stripPhantomPrefix([previous, next]);

        expect(normalized[1]?.metadata).toEqual({
            createdAt: "2026-06-05T10:00:11.000Z",
            modelId: "model-a",
        });
    });
});
