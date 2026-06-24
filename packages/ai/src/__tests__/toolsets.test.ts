import { describe, expect, mock, test } from "bun:test";

mock.module("@kiwi/db", () => ({
    betterAuthDb: {},
    db: {},
}));

const {
    buildDeepResearchToolset,
    buildGraphExplorationToolset,
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

    test("uses only subagent tools for deep research", () => {
        expect(
            Object.keys(
                buildDeepResearchToolset({
                    explore_graph_with_subagent: {} as never,
                    curate_sources_with_subagent: {} as never,
                })
            ).sort()
        ).toEqual(["curate_sources_with_subagent", "explore_graph_with_subagent"]);
    });
});
