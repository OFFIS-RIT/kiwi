import { describe, expect, mock, test } from "bun:test";

const generateMock = mock(async ({ prompt }: { prompt: string }) => ({
    text: `generated:${prompt}`,
}));

mock.module("ai", async () => {
    return {
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

const { buildSubagentToolset } = await import("../agents/subagents");

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
});
