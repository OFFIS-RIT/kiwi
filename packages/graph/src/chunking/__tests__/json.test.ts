import { describe, expect, test } from "bun:test";
import { JSONChunker } from "../json.ts";

describe("JSONChunker", () => {
    test("returns no chunks for empty input", async () => {
        const chunks = await new JSONChunker({ maxChunkSize: 100 }).getChunks("");

        expect(chunks).toEqual([]);
    });

    test("returns small JSON as a single chunk", async () => {
        const input = '{"name":"Alice","age":30}';
        const chunks = await new JSONChunker({ maxChunkSize: 100 }).getChunks(input);

        expect(chunks).toEqual([input]);
    });

    test("splits large top-level objects while preserving key order", async () => {
        const input = '{"zebra":"a","alpha":"b","middle":"c"}';
        const chunks = await new JSONChunker({ maxChunkSize: 10 }).getChunks(input);

        expect(chunks).toHaveLength(3);
        expect(chunks[0]).toContain('"zebra"');
        expect(chunks[1]).toContain('"alpha"');
        expect(chunks[2]).toContain('"middle"');
    });

    test("adds path prefixes for recursively split nested values", async () => {
        const input = JSON.stringify({
            data: {
                a: "x".repeat(120),
                b: "y".repeat(120),
            },
        });

        const chunks = await new JSONChunker({ maxChunkSize: 20 }).getChunks(input);

        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.startsWith("Path: $.data")).toBe(true);
        }
    });

    test("falls back to a single chunk for invalid json", async () => {
        const input = "{not valid json: [}";
        const chunks = await new JSONChunker({ maxChunkSize: 10 }).getChunks(input);

        expect(chunks).toEqual([input]);
    });

    test("returns source spans for chunks that remain verbatim JSON", async () => {
        const input = '{"name":"Alice","age":30}';

        const spans = await new JSONChunker({ maxChunkSize: 100 }).getChunkSpans(input);

        expect(spans).toEqual([
            {
                content: input,
                startOffset: 0,
                endOffset: input.length,
            },
        ]);
    });

    test("marks path-prefixed synthetic chunks as unmatched spans", async () => {
        const input = JSON.stringify({
            data: {
                a: "x".repeat(120),
                b: "y".repeat(120),
            },
        });

        const spans = await new JSONChunker({ maxChunkSize: 20 }).getChunkSpans(input);

        expect(spans.length).toBeGreaterThan(1);
        expect(spans.every((span) => span.content.startsWith("Path: $.data"))).toBe(true);
        expect(spans.every((span) => span.startOffset === 0 && span.endOffset === 0)).toBe(true);
    });
});
