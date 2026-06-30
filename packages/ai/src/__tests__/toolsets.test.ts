import { describe, expect, mock, test } from "bun:test";

mock.module("@kiwi/db", () => ({
    betterAuthDb: {},
    db: {},
}));

const {
    buildCodeSearchToolset,
    buildDeepResearchToolset,
    buildGraphExplorationToolset,
    buildMcpResearchToolset,
    buildServerAndClientToolset,
    buildServerToolset,
    buildSourceCurationToolset,
    buildSourceGroundingToolset,
} = await import("../tools/toolsets");

const options = {
    graphId: "graph-1",
    embeddingModel: {} as never,
};
const correction = {
    graphId: "graph-1",
    userId: "user-1",
    chatId: "chat-1",
    messageId: "message-1",
};
const codeToolNames = [
    "code_list_files",
    "code_search_symbols",
    "code_get_file_outline",
    "code_get_relationships",
    "code_trace_calls",
];
describe("toolsets", () => {
    test("groups graph exploration tools", () => {
        expect(Object.keys(buildGraphExplorationToolset(options)).sort()).toEqual([
            "get_entity_neighbours",
            "get_path_between_entities",
            "get_relationships",
            "list_entities",
            "list_files",
            "search_entities",
            "search_relationships",
        ]);
    });

    test("groups source grounding tools", () => {
        expect(Object.keys(buildSourceGroundingToolset(options)).sort()).toEqual([
            "get_entity_sources",
            "get_relationship_sources",
            "similar_sources_check",
        ]);
    });

    test("adds source file metadata only to the source curation toolset", () => {
        expect(Object.keys(buildSourceCurationToolset(options)).sort()).toEqual([
            "get_entity_sources",
            "get_relationship_sources",
            "get_source_file_metadata",
            "similar_sources_check",
        ]);
        expect(Object.keys(buildServerToolset(options))).not.toContain("get_source_file_metadata");
    });

    test("builds code-scoped search tools for the code search subagent", () => {
        expect(Object.keys(buildCodeSearchToolset(options)).sort()).toEqual([
            "get_entity_neighbours",
            "get_entity_sources",
            "get_path_between_entities",
            "get_relationship_sources",
            "get_relationships",
            "get_source_file_metadata",
            "list_entities",
            "list_files",
            "search_entities",
            "search_relationships",
            "similar_sources_check",
        ]);
    });

    test("keeps client tools out of the server-only toolset", () => {
        const toolNames = Object.keys(buildServerToolset(options));

        expect(toolNames).toContain("search_entities");
        expect(toolNames).toContain("get_entity_sources");
        expect(toolNames).toContain("similar_sources_check");
        expect(toolNames).not.toContain("correction");
        expect(toolNames).not.toContain("ask_clarifying_questions");
    });

    test("adds correction only when suggestion context is provided", () => {
        expect(Object.keys(buildServerToolset(options))).not.toContain("correction");
        expect(Object.keys(buildServerToolset({ ...options, correction }))).toContain("correction");
        expect(Object.keys(buildServerAndClientToolset(options))).not.toContain("correction");
        expect(Object.keys(buildServerAndClientToolset({ ...options, correction }))).toContain("correction");
    });

    test("adds client tools to the server-and-client toolset", () => {
        expect(Object.keys(buildServerAndClientToolset(options))).toContain("ask_clarifying_questions");
    });

    test("keeps dedicated MCP code tools out of normal query toolsets", () => {
        const normalToolsets = [
            Object.keys(buildServerToolset(options)),
            Object.keys(buildServerAndClientToolset(options)),
            Object.keys(buildMcpResearchToolset(options)),
        ];

        for (const toolset of normalToolsets) {
            for (const codeToolName of codeToolNames) {
                expect(toolset).not.toContain(codeToolName);
            }
            expect(toolset).not.toContain("code_search");
        }
    });

    test("uses supplied subagent tools for deep research", () => {
        expect(
            Object.keys(
                buildDeepResearchToolset({
                    explore_graph_with_subagent: {} as never,
                    curate_sources_with_subagent: {} as never,
                })
            ).sort()
        ).toEqual(["curate_sources_with_subagent", "explore_graph_with_subagent"]);

        expect(
            Object.keys(
                buildDeepResearchToolset({
                    explore_graph_with_subagent: {} as never,
                    curate_sources_with_subagent: {} as never,
                    code_search: {} as never,
                })
            ).sort()
        ).toEqual(["code_search", "curate_sources_with_subagent", "explore_graph_with_subagent"]);
    });
});
