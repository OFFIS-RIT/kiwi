import { describe, expect, mock, test } from "bun:test";

mock.module("@kiwi/db", () => ({
    db: {},
}));

const {
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
        ]);
    });

    test("adds source file metadata only to the source curation toolset", () => {
        expect(Object.keys(buildSourceCurationToolset(options)).sort()).toEqual([
            "get_entity_sources",
            "get_relationship_sources",
            "get_source_file_metadata",
        ]);
        expect(Object.keys(buildServerToolset(options))).not.toContain("get_source_file_metadata");
    });

    test("keeps client tools out of the server-only toolset", () => {
        const toolNames = Object.keys(buildServerToolset(options));

        expect(toolNames).toContain("search_entities");
        expect(toolNames).toContain("get_entity_sources");
        expect(toolNames).not.toContain("ask_clarifying_questions");
    });

    test("adds client tools to the server-and-client toolset", () => {
        expect(Object.keys(buildServerAndClientToolset(options))).toContain("ask_clarifying_questions");
    });
});
