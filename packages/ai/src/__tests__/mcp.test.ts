import { describe, expect, test } from "bun:test";

import { linkifyResearchCitations } from "../mcp";

describe("linkifyResearchCitations", () => {
    test("replaces citation fences with markdown links", async () => {
        const output = await linkifyResearchCitations(
            'Alpha :::{"type":"cite","id":"src_1"}::: Omega',
            async (citation) => `[${citation.sourceId}](https://example.com/${citation.sourceId})`
        );

        expect(output).toBe("Alpha [src_1](https://example.com/src_1) Omega");
    });

    test("preserves non-citation text exactly", async () => {
        const output = await linkifyResearchCitations(
            "Line one\nLine two",
            async () => "[unused](https://example.com)"
        );

        expect(output).toBe("Line one\nLine two");
    });

    test("preserves repeated citation order", async () => {
        const output = await linkifyResearchCitations(
            'A :::{"type":"cite","id":"src_1"}::: B :::{"type":"cite","id":"src_2"}::: C :::{"type":"cite","id":"src_1"}:::',
            async (citation) => `[${citation.sourceId}](/${citation.sourceId})`
        );

        expect(output).toBe("A [src_1](/src_1) B [src_2](/src_2) C [src_1](/src_1)");
    });

    test("supports unresolved citation fallbacks", async () => {
        const output = await linkifyResearchCitations(
            'Alpha :::{"type":"cite","id":"src_1"}:::',
            async () => "[source unavailable]"
        );

        expect(output).toBe("Alpha [source unavailable]");
    });
});
