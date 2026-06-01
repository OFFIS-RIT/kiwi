import { describe, expect, test } from "bun:test";
import { extractPrompt } from "../prompts/extract.prompt";

describe("extractPrompt", () => {
    test("documents source chunk fences as attribution markers, not content", () => {
        const prompt = extractPrompt(["FACT"], "Lease");

        expect(prompt).toContain(":::SOURCE-CHUNK-<id> type=<text|image>:::");
        expect(prompt).toContain(":::END-SOURCE-CHUNK-<id>:::");
        expect(prompt).toContain("Source attribution fences are not document content");
        expect(prompt).toContain("Read the text between source attribution fences in order as one continuous document");
        expect(prompt).toContain("\"sourceChunkIds\": [2]");
    });
});
