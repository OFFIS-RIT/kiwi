import { describe, expect, test } from "bun:test";
import { SingleChunker } from "../single.ts";

describe("SingleChunker", () => {
    test("returns the full input as one chunk", async () => {
        const chunks = await new SingleChunker().getChunks("hello\nworld");

        expect(chunks).toEqual(["hello\nworld"]);
    });

    test("preserves empty input as a single empty chunk", async () => {
        const chunks = await new SingleChunker().getChunks("");

        expect(chunks).toEqual([""]);
    });

    test("returns a source span for the full input", async () => {
        const spans = await new SingleChunker().getChunkSpans("hello\nworld");

        expect(spans).toEqual([
            {
                content: "hello\nworld",
                startOffset: 0,
                endOffset: 11,
            },
        ]);
    });
});
