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

    test("chunks jsonl records instead of treating them as invalid json", async () => {
        const input = '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}\n{"id":3,"name":"Cara"}';
        const chunks = await new JSONChunker({ maxChunkSize: 10 }).getChunks(input);

        expect(chunks).toEqual(['{"id":1,"name":"Alice"}', '{"id":2,"name":"Bob"}', '{"id":3,"name":"Cara"}']);
    });

    test("chunks jsonl records with legacy carriage-return line endings", async () => {
        const input = '{"id":1}\r{"id":2}\r{"id":3}';
        const chunks = await new JSONChunker({ maxChunkSize: 8 }).getChunks(input);

        expect(chunks).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
    });

    test("does not partially chunk invalid jsonl", async () => {
        const input = '{"ok":true}\nnot-json\n{"ok":false}';
        const chunks = await new JSONChunker({ maxChunkSize: 5 }).getChunks(input);

        expect(chunks).toEqual([input]);
    });

    test("parses jsonc comments and trailing commas before structured chunking", async () => {
        const input = `{
  // keep source key order
  "zebra": "${"a".repeat(120)}",
  "alpha": "${"b".repeat(120)}",
}`;
        const chunks = await new JSONChunker({ maxChunkSize: 20 }).getChunks(input);

        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toContain("zebra");
        expect(chunks[1]).toContain("alpha");
    });

    test("keeps jsonc comment markers inside string values", async () => {
        const input = `{
  "url": "https://example.test/a//b",
  "pattern": "/*literal*/",
  "items": [1, 2,],
  "tail": true, // real comment
}`;
        const chunks = await new JSONChunker({ maxChunkSize: 12 }).getChunks(input);
        const output = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(output).toContain("https://example.test/a//b");
        expect(output).toContain("/*literal*/");
        expect(output).not.toContain("real comment");
    });

    test("ends jsonc line comments at carriage returns", async () => {
        const input = `{\r  "first": "${"a".repeat(80)}", // comment\r  "second": "${"b".repeat(80)}",\r}`;
        const chunks = await new JSONChunker({ maxChunkSize: 20 }).getChunks(input);

        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toContain("first");
        expect(chunks[1]).toContain("second");
    });

    test("resolves spans for whitespace-separated jsonl records", async () => {
        const input = '\n  {"id":1}\n\n\t{"id":2}\n';
        const spans = await new JSONChunker({ maxChunkSize: 6 }).getChunkSpans(input);

        expect(spans).toEqual([
            {
                content: '{"id":1}',
                startOffset: 3,
                endOffset: 11,
            },
            {
                content: '{"id":2}',
                startOffset: 14,
                endOffset: 22,
            },
        ]);
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
