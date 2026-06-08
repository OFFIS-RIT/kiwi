import { describe, expect, test } from "bun:test";
import { CSVChunker } from "../csv.ts";

describe("CSVChunker", () => {
    test("returns no chunks for empty input", async () => {
        const chunks = await new CSVChunker({ maxChunkSize: 100 }).getChunks("");

        expect(chunks).toEqual([]);
    });

    test("returns a single chunk for one row", async () => {
        const chunks = await new CSVChunker({ maxChunkSize: 100 }).getChunks("name,age,email");

        expect(chunks).toEqual(["name,age,email"]);
    });

    test("repeats the header in every split chunk", async () => {
        const input = [
            "id,name,email",
            "1,Alice,alice@example.com",
            "2,Bob,bob@example.com",
            "3,Charlie,charlie@example.com",
            "4,Dave,dave@example.com",
        ].join("\n");

        const chunks = await new CSVChunker({ maxChunkSize: 10 }).getChunks(input);

        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.startsWith("id,name,email\n")).toBe(true);
        }
    });

    test("splits only between complete quoted rows", async () => {
        const input = ["id,note", '1,"first line\nsecond line"', "2,next"].join("\n");

        const chunks = await new CSVChunker({ maxChunkSize: 4 }).getChunks(input);

        expect(chunks).toEqual(['id,note\n1,"first line\nsecond line"', "id,note\n2,next"]);
    });

    test("rejects malformed quoted rows", async () => {
        await expect(new CSVChunker({ maxChunkSize: 100 }).getChunks('id,note\n1,"unterminated')).rejects.toThrow(
            "Invalid CSV content"
        );
    });

    test("keeps an oversized row intact when it exceeds the chunk target", async () => {
        const longValue = Array.from({ length: 50 }, (_, index) => `word${index}`).join(" ");
        const input = ["id,description", `1,${longValue}`, "2,short"].join("\n");

        const chunks = await new CSVChunker({ maxChunkSize: 4 }).getChunks(input);

        expect(chunks).toEqual(["id,description\n1," + longValue, "id,description\n2,short"]);
    });

    test("does not duplicate the first row when there is no header", async () => {
        const input = ["1,Alice", "2,Bob", "3,Charlie"].join("\n");

        const chunks = await new CSVChunker({ maxChunkSize: 1 }).getChunks(input);

        expect(chunks).toEqual(["1,Alice", "2,Bob", "3,Charlie"]);
    });

    test("returns source spans for verbatim chunks", async () => {
        const input = ["1,Alice", "2,Bob", "3,Charlie"].join("\n");

        const spans = await new CSVChunker({ maxChunkSize: 1 }).getChunkSpans(input);

        expect(spans.map(({ content, startOffset, endOffset }) => ({ content, startOffset, endOffset }))).toEqual([
            { content: "1,Alice", startOffset: 0, endOffset: 7 },
            { content: "2,Bob", startOffset: 8, endOffset: 13 },
            { content: "3,Charlie", startOffset: 14, endOffset: 23 },
        ]);
    });
});
