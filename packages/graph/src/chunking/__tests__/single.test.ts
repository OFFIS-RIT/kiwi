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
});
