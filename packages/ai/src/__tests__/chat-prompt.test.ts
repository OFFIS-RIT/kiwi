import { describe, expect, test } from "bun:test";
import { createChatPrompt } from "../prompts/chat.prompt";

describe("createChatPrompt", () => {
    test("does not mention subagent tools when graph and subagent tools are disabled", () => {
        const prompt = createChatPrompt({
            includeGraphTools: false,
            includeClientTools: false,
            includeSubagentTools: false,
        });

        expect(prompt).not.toContain("explore_graph_with_subagent");
        expect(prompt).not.toContain("curate_sources_with_subagent");
    });

    test("warns when prior graph tool results may be stale", () => {
        const prompt = createChatPrompt({
            graphDataRefresh: {
                processedAt: "2026-01-02T00:00:00.000Z",
            },
        });

        expect(prompt).toContain("# Graph Data Refresh Notice");
        expect(prompt).toContain("A graph processing workflow completed after earlier graph tool calls in this chat.");
        expect(prompt).toContain(
            "Treat previous graph tool outputs, source lists, and citation IDs as potentially stale."
        );
        expect(prompt).toContain("Most recent completed workflow marker: 2026-01-02T00:00:00.000Z.");
    });
});
