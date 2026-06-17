import { describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";

const generateMock = mock(async ({ prompt }: { prompt: string }) => ({
    text: `generated:${prompt}`,
}));
const generateTextMock = mock(async ({ prompt }: { prompt: string }) => ({
    text: `compacted:${prompt}`,
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

mock.module("ai", async () => {
    return {
        embed: embedMock,
        generateText: generateTextMock,
        simulateReadableStream: simulateReadableStreamMock,
        stepCountIs: () => Symbol("stop"),
        ToolLoopAgent: class {
            generate = generateMock;
        },
        tool: <T extends Record<string, unknown>>(definition: T) => definition,
        validateUIMessages: validateUIMessagesMock,
    };
});

mock.module("@kiwi/db", () => ({
    db: {},
}));

const { buildSubagentToolset, compactConversationHistory } = await import("../agents/subagents");

describe("subagent tools", () => {
    test("delegates graph exploration with the specialized task prompt", async () => {
        generateMock.mockClear();

        const toolset = buildSubagentToolset({
            graphId: "graph-1",
            embeddingModel: {} as never,
            model: {} as never,
        });

        const result = await toolset.explore_graph_with_subagent.execute?.(
            { task: "Find the most relevant entities" },
            { abortSignal: AbortSignal.abort("stop") }
        );

        const call = generateMock.mock.calls[0]?.[0] as { prompt: string; abortSignal?: AbortSignal };
        expect(call.prompt).toContain("Complete this graph exploration task for the parent agent.");
        expect(call.prompt).toContain("Task: Find the most relevant entities");
        expect(call.abortSignal).toEqual(expect.any(AbortSignal));
        expect(result).toBe(`generated:${call.prompt}`);
    });

    test("passes scoped prompt guidance with delegated subagent tasks", async () => {
        generateMock.mockClear();

        const toolset = buildSubagentToolset({
            graphId: "graph-1",
            embeddingModel: {} as never,
            model: {} as never,
            promptGuidance: {
                teamPrompts: ["Use the team's glossary."],
            },
        });

        await toolset.explore_graph_with_subagent.execute?.(
            { task: "Find the most relevant entities" },
            { abortSignal: undefined }
        );

        const call = generateMock.mock.calls[0]?.[0] as { prompt: string };
        expect(call.prompt).toContain("## Team Specific Prompts");
        expect(call.prompt).toContain("Use the team's glossary.");
        expect(call.prompt).toContain("Complete this graph exploration task for the parent agent.");
        expect(call.prompt).toContain("Task: Find the most relevant entities");
    });

    test("delegates source curation with the specialized task prompt", async () => {
        generateMock.mockClear();

        const toolset = buildSubagentToolset({
            graphId: "graph-1",
            embeddingModel: {} as never,
            model: {} as never,
        });

        const result = await toolset.curate_sources_with_subagent.execute?.(
            {
                task: "Find source evidence",
                entityIds: ["entity-1"],
                relationshipIds: ["rel-1"],
                query: "roadmap",
                files: ["file-1"],
            },
            { abortSignal: undefined }
        );

        const call = generateMock.mock.calls[0]?.[0] as { prompt: string; abortSignal?: AbortSignal };
        expect(call.prompt).toContain("Find the best source evidence for the parent agent.");
        expect(call.prompt).toContain("Task: Find source evidence");
        expect(call.prompt).toContain("Entity IDs: entity-1");
        expect(call.prompt).toContain("Relationship IDs: rel-1");
        expect(call.prompt).toContain("File IDs: file-1");
        expect(call.prompt).toContain("Refinement query: roadmap");
        expect(call.abortSignal).toBeUndefined();
        expect(result).toBe(`generated:${call.prompt}`);
    });

    test("runs the compaction helper with the dedicated prompt and output cap", async () => {
        generateTextMock.mockClear();
        const model = {} as never;

        const result = await Effect.runPromise(
            compactConversationHistory({
                model,
                promptGuidance: {
                    userPrompts: ["Prefer terse summaries."],
                    teamPrompts: ["Use team phrasing."],
                    graphPrompts: ["ACME means Acme Corp."],
                },
                previousSummary: "Earlier summary",
                transcript: "User: hi",
            })
        );

        const call = generateTextMock.mock.calls[0]?.[0] as {
            model: unknown;
            system: string;
            prompt: string;
            temperature: number;
            maxOutputTokens: number;
            abortSignal?: AbortSignal;
        };

        expect(call.model).toBe(model);
        expect(call.system).toContain("chat compaction agent");
        expect(call.prompt).not.toContain("## User Specific Prompts");
        expect(call.prompt).not.toContain("Prefer terse summaries.");
        expect(call.prompt).not.toContain("## Team Specific Prompts");
        expect(call.prompt).not.toContain("Use team phrasing.");
        expect(call.prompt).toContain("## Graph Specific Prompts");
        expect(call.prompt).toContain("ACME means Acme Corp.");
        expect(call.prompt).toContain("Previous summary:");
        expect(call.prompt).toContain("Transcript to compact:");
        expect(call.temperature).toBe(0.1);
        expect(call.maxOutputTokens).toBe(6000);
        expect(call.abortSignal).toBeUndefined();
        expect(result).toContain("compacted:");
    });
});
