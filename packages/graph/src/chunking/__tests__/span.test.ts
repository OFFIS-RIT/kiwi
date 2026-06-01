import { describe, expect, test } from "bun:test";
import { resolveTextChunkSpans } from "../span.ts";

describe("resolveTextChunkSpans", () => {
    test("resolves repeated chunk text from the current cursor", () => {
        const text = ["Alpha", "Beta", "Alpha"].join("\n");

        expect(resolveTextChunkSpans(text, ["Alpha", "Alpha"])).toEqual([
            {
                content: "Alpha",
                startOffset: 0,
                endOffset: 5,
            },
            {
                content: "Alpha",
                startOffset: 11,
                endOffset: 16,
            },
        ]);
    });

    test("resolves chunks when only whitespace differs", () => {
        const text = "Alpha   beta\nGamma";

        expect(resolveTextChunkSpans(text, ["Alpha beta Gamma"])).toEqual([
            {
                content: "Alpha beta Gamma",
                startOffset: 0,
                endOffset: text.length,
            },
        ]);
    });

    test("keeps later matching chunks resolvable after an unmatched chunk", () => {
        expect(resolveTextChunkSpans("Alpha Beta", ["Missing", "Alpha"])).toEqual([
            {
                content: "Missing",
                startOffset: 0,
                endOffset: 0,
            },
            {
                content: "Alpha",
                startOffset: 0,
                endOffset: 5,
            },
        ]);
    });
});
