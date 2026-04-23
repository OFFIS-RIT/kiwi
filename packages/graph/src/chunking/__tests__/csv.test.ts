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

    test("does not duplicate the first row when there is no header", async () => {
        const input = ["1,Alice", "2,Bob", "3,Charlie"].join("\n");

        const chunks = await new CSVChunker({ maxChunkSize: 1 }).getChunks(input);

        expect(chunks).toEqual(["1,Alice", "2,Bob", "3,Charlie"]);
    });

});
