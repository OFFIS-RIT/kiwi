import { describe, expect, it, vi } from "vitest";

import { shouldAutoContinue, withDefaultAutoContinue } from "./chat-auto-continue";

describe("chat auto continue", () => {
    const answeredClarification = {
        id: "assistant-1",
        role: "assistant" as const,
        parts: [
            {
                type: "tool-ask_clarifying_questions",
                toolCallId: "tool-1",
                state: "output-available",
                input: { questions: ["Which source?"] },
                output: { answers: ["The PDF"] },
            },
        ],
    };

    it("continues after an answered clarification tool call", () => {
        expect(shouldAutoContinue({ messages: [answeredClarification] })).toBe(true);
    });

    it("does not continue once the assistant has appended a follow-up part", () => {
        expect(
            shouldAutoContinue({
                messages: [
                    {
                        ...answeredClarification,
                        parts: [...answeredClarification.parts, { type: "text", text: "Thanks, checking now." }],
                    },
                ],
            })
        ).toBe(false);
    });

    it("continues when the model emitted a trailing empty text part after the clarification tool", () => {
        expect(
            shouldAutoContinue({
                messages: [
                    {
                        ...answeredClarification,
                        parts: [...answeredClarification.parts, { type: "text", text: "\n\n\n" }],
                    },
                ],
            })
        ).toBe(true);
    });

    it("adds the clarification auto-continue callback to requested sessions", () => {
        const init = withDefaultAutoContinue({ sessionId: "chat-1", initialMessages: [] });

        expect(init.sendAutomaticallyWhen?.({ messages: [answeredClarification] })).toBe(true);
    });

    it("preserves an explicit auto-continue callback", () => {
        const sendAutomaticallyWhen = vi.fn(() => false);
        const init = withDefaultAutoContinue({ sessionId: "chat-1", initialMessages: [], sendAutomaticallyWhen });

        expect(init.sendAutomaticallyWhen).toBe(sendAutomaticallyWhen);
    });
});
