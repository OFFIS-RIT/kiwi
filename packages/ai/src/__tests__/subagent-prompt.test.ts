import { describe, expect, test } from "bun:test";

import {
    createExploreSubagentPrompt,
    createExploreSubagentTaskPrompt,
    createSourceCuratorSubagentPrompt,
    createSourceCuratorTaskPrompt,
} from "../prompts/subagent.prompt";

describe("subagent prompts", () => {
    test("explore prompt gives the graph subagent a dedicated output contract", () => {
        const prompt = createExploreSubagentPrompt("Prefer legal entities.");

        expect(prompt).toContain("explore one graph-backed project in depth");
        expect(prompt).toContain("## Relevant Entities");
        expect(prompt).toContain("Essential:");
        expect(prompt).toContain("# Project-Specific Guidance\nPrefer legal entities.");
    });

    test("source curator prompt gives the source subagent a curated facts contract", () => {
        const prompt = createSourceCuratorSubagentPrompt();

        expect(prompt).toContain("explore sources in depth");
        expect(prompt).toContain("## Curated Facts");
        expect(prompt).toContain("Critical:");
        expect(prompt).toContain("## Best Citation Candidates");
    });

    test("task prompts keep delegated work specialized", () => {
        expect(createExploreSubagentTaskPrompt("Map the important entities")).toContain(
            "Complete this graph exploration task for the parent agent."
        );

        expect(
            createSourceCuratorTaskPrompt({
                task: "Find supporting sources",
                entityIds: ["entity-1"],
                query: "binding agreement",
            })
        ).toContain("Find the best source evidence for the parent agent.");
    });
});
