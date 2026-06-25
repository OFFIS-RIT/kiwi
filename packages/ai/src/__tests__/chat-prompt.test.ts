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

    test("mentions correction only when correction tool is enabled", () => {
        const defaultPrompt = createChatPrompt();
        const correctionPrompt = createChatPrompt({ includeCorrectionTool: true });

        expect(defaultPrompt).not.toContain("- correction:");
        expect(defaultPrompt).not.toContain("# Correction Suggestion Rules");
        expect(correctionPrompt).toContain("- correction:");
        expect(correctionPrompt).toContain("# Correction Suggestion Rules");
        expect(correctionPrompt).toContain("stores only; admins apply or delete suggestions later");
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

    test("requires similar source checks for answer-determining evidence", () => {
        const prompt = createChatPrompt();

        expect(prompt).toContain("similar_sources_check");
        expect(prompt).toContain("# Contradiction Verification Gate");
        expect(prompt).toContain("the retrieval phase is incomplete until you run similar_sources_check");
        expect(prompt).toContain("similar_sources_check is required before the final answer");
        expect(prompt).toContain("not optional just because the first source seems sufficient");
        expect(prompt).toContain("final answer must lead with that disagreement");
        expect(prompt).toContain("Do not settle for one answer");
        expect(prompt).toContain("similar_sources_check, or source IDs");
    });

    test("includes request information when provided", () => {
        const prompt = createChatPrompt({
            requestInformation: {
                currentDate: "2026-06-08",
                currentWeekday: "Monday",
                userName: "Ada Lovelace",
            },
        });

        expect(prompt).toContain("## Request information");
        expect(prompt).toContain("Current date: 2026-06-08");
        expect(prompt).toContain("Current weekday: Monday");
        expect(prompt).toContain("Requesting user: Ada Lovelace");
    });
});
