import { describe, expect, test } from "bun:test";

import { createCompactionPrompt, createCompactionTaskPrompt } from "../prompts/compaction.prompt";

describe("compaction prompts", () => {
    test("defines a reusable compaction output contract", () => {
        const prompt = createCompactionPrompt("Prefer binding decisions.");

        expect(prompt).toContain("chat compaction agent");
        expect(prompt).toContain("## Active Goals");
        expect(prompt).toContain("## Established Facts");
        expect(prompt).toContain('# Project-Specific Guidance\nPrefer binding decisions.');
    });

    test("task prompt includes prior summary and transcript", () => {
        const prompt = createCompactionTaskPrompt({
            previousSummary: "Earlier summary",
            transcript: "Role: user\nText: hello",
        });

        expect(prompt).toContain("Previous summary:");
        expect(prompt).toContain("Transcript to compact:");
        expect(prompt).toContain("Return only the compacted summary");
    });
});
