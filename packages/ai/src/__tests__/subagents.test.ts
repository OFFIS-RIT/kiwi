import { describe, expect, mock, test } from "bun:test";

const generateMock = mock(async ({ prompt }: { prompt: string }) => ({
    text: `generated:${prompt}`,
}));
const generateTextMock = mock(async ({ prompt }: { prompt: string }) => ({
    text: `compacted:${prompt}`,
}));

mock.module("ai", async () => {
    return {
        generateText: generateTextMock,
        stepCountIs: () => Symbol("stop"),
        ToolLoopAgent: class {
            generate = generateMock;
        },
        tool: <T extends Record<string, unknown>>(definition: T) => definition,
    };
});

mock.module("../prompts/subagent.prompt", () => ({
    createExploreSubagentPrompt: () => "explore",
    createExploreSubagentTaskPrompt: (task: string) => `explore-task:${task}`,
    createSourceCuratorSubagentPrompt: () => "curate",
    createSourceCuratorTaskPrompt: (input: {
        task: string;
        entityIds?: string[];
        relationshipIds?: string[];
        query?: string;
        files?: string[];
    }) => `curate-task:${JSON.stringify(input)}`,
}));

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

        expect(generateMock).toHaveBeenCalledWith({
            prompt: "explore-task:Find the most relevant entities",
            abortSignal: expect.any(AbortSignal),
        });
        expect(result).toBe("generated:explore-task:Find the most relevant entities");
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

        expect(generateMock).toHaveBeenCalledWith({
            prompt:
                'curate-task:{"task":"Find source evidence","entityIds":["entity-1"],"relationshipIds":["rel-1"],"query":"roadmap","files":["file-1"]}',
            abortSignal: undefined,
        });
        expect(result).toBe(
            'generated:curate-task:{"task":"Find source evidence","entityIds":["entity-1"],"relationshipIds":["rel-1"],"query":"roadmap","files":["file-1"]}'
        );
    });

    test("runs the compaction helper with the dedicated prompt and output cap", async () => {
        generateTextMock.mockClear();
        const model = {} as never;

        const result = await compactConversationHistory({
            model,
            graphPrompt: "Prefer decisions.",
            previousSummary: "Earlier summary",
            transcript: "User: hi",
        });

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
        expect(call.prompt).toContain("Previous summary:");
        expect(call.prompt).toContain("Transcript to compact:");
        expect(call.temperature).toBe(0.1);
        expect(call.maxOutputTokens).toBe(6000);
        expect(call.abortSignal).toBeUndefined();
        expect(result).toContain("compacted:");
    });
});
