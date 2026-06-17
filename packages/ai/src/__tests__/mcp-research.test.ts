import { describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";

const generateTextMock = mock(async () => ({
    content: [{ type: "text" as const, text: "Answer" }],
}));
const embedMock = mock(async () => ({ embedding: [] }));
const validateUIMessagesMock = mock(async ({ messages }: { messages: unknown[] }) => messages);

function simulateReadableStreamMock({ chunks }: { chunks: string[] }) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });
}

mock.module("ai", async () => ({
    embed: embedMock,
    generateText: generateTextMock,
    simulateReadableStream: simulateReadableStreamMock,
    stepCountIs: () => Symbol("stop"),
    ToolLoopAgent: class {
        generate = mock(async () => ({ text: "" }));
    },
    tool: <T extends Record<string, unknown>>(definition: T) => definition,
    validateUIMessages: validateUIMessagesMock,
}));

const { runMcpResearch } = await import("../mcp/research");

describe("runMcpResearch", () => {
    test("prepends scoped prompt guidance to the research question", async () => {
        generateTextMock.mockClear();

        const result = await Effect.runPromise(
            runMcpResearch({
                model: {} as never,
                question: "What changed?",
                promptGuidance: {
                    graphPrompts: ["ACME means Acme Corp."],
                },
            })
        );

        const call = generateTextMock.mock.calls[0]?.[0] as {
            messages: Array<{ role: string; content: string }>;
        };

        expect(result.answer).toBe("Answer");
        expect(call.messages[0]?.content).toContain("## Graph Specific Prompts");
        expect(call.messages[0]?.content).toContain("ACME means Acme Corp.");
        expect(call.messages[0]?.content.endsWith("What changed?")).toBe(true);
    });
});
