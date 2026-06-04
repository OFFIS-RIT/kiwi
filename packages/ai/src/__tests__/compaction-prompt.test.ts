import { describe, expect, test } from "bun:test";

import { createCompactionPrompt, createCompactionTaskPrompt } from "../prompts/compaction.prompt";

describe("compaction prompts", () => {
    test("defines a reusable compaction output contract", () => {
        const prompt = createCompactionPrompt();

        expect(prompt).toContain("chat compaction agent");
        expect(prompt).toContain("## User Objective");
        expect(prompt).toContain("## Key Entities, Relationships, and Sources");
        expect(prompt).toContain("Preserve exact entity IDs, relationship IDs, source IDs, file IDs");
        expect(prompt).not.toContain("Project-Specific Guidance");
    });

    test("task prompt includes prior summary and transcript", () => {
        const prompt = createCompactionTaskPrompt({
            previousSummary: "Earlier summary",
            transcript: "Role: user\nText: hello",
        });

        expect(prompt).toContain("Update the anchored summary below");
        expect(prompt).toContain("Previous summary:");
        expect(prompt).toContain("Transcript to compact:");
        expect(prompt).toContain("Return only the compacted summary");
    });
});
