import { describe, expect, test } from "bun:test";
import { createPromptGuidanceMessage, insertPromptGuidanceMessage } from "../prompt-guidance";

describe("prompt guidance", () => {
    test("does not inject an artificial message when all scoped prompts are empty", () => {
        const messages = [{ role: "user" as const, content: "hello" }];

        expect(
            insertPromptGuidanceMessage(messages, {
                userPrompts: ["  "],
                teamPrompts: [],
                graphPrompts: undefined,
            })
        ).toBe(messages);
    });

    test("injects guidance immediately before the latest user message", () => {
        const messages = [
            { role: "user" as const, content: "first" },
            { role: "assistant" as const, content: "answer" },
            { role: "user" as const, content: "latest" },
        ];

        const nextMessages = insertPromptGuidanceMessage(messages, {
            userPrompts: ["Prefer concise answers."],
            teamPrompts: ["Use the team's glossary."],
            graphPrompts: ["ACME means Acme Corp."],
        });

        expect(nextMessages).toHaveLength(4);
        expect(nextMessages[0]).toBe(messages[0]);
        expect(nextMessages[1]).toBe(messages[1]);
        expect(nextMessages[2]?.role).toBe("user");
        expect(nextMessages[2]?.content).toContain("## User Specific Prompts");
        expect(nextMessages[2]?.content).toContain("## Team Specific Prompts");
        expect(nextMessages[2]?.content).toContain("## Graph Specific Prompts");
        expect(nextMessages[2]?.content).toContain("must never violate Kiwi's core rules");
        expect(nextMessages[3]).toBe(messages[2]);
    });

    test("does not append guidance when there is no user message to precede", () => {
        const messages = [{ role: "assistant" as const, content: "answer" }];
        const guidance = { graphPrompts: ["ACME means Acme Corp."] };

        expect(insertPromptGuidanceMessage(messages, guidance)).toBe(messages);

        const emptyMessages: Parameters<typeof insertPromptGuidanceMessage>[0] = [];
        expect(insertPromptGuidanceMessage(emptyMessages, guidance)).toBe(emptyMessages);
    });

    test("creates no guidance message without non-empty scoped prompts", () => {
        expect(createPromptGuidanceMessage()).toBeNull();
        expect(createPromptGuidanceMessage({ graphPrompts: ["\n\t"] })).toBeNull();
    });
});
