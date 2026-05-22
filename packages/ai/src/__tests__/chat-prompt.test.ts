import { describe, expect, test } from "bun:test";
import { createChatPrompt } from "../prompts/chat.prompt";

describe("createChatPrompt", () => {
    test("does not mention subagent tools when graph and subagent tools are disabled", () => {
        const prompt = createChatPrompt(undefined, {
            includeGraphTools: false,
            includeClientTools: false,
            includeSubagentTools: false,
        });

        expect(prompt).not.toContain("explore_graph_with_subagent");
        expect(prompt).not.toContain("curate_sources_with_subagent");
    });
});
