import { describe, expect, test } from "bun:test";
import { SemanticChunker } from "../semantic.ts";

describe("SemanticChunker", () => {
    test("returns no chunks for empty input", async () => {
        const chunks = await new SemanticChunker(100).getChunks("");

        expect(chunks).toEqual([]);
    });

    test("returns a single chunk for short text", async () => {
        const chunks = await new SemanticChunker(100).getChunks("Hello world.");

        expect(chunks).toEqual(["Hello world."]);
    });

    test("splits oversized markdown by headings", async () => {
        const input = [
            "# Introduction",
            "Intro sentence one. Intro sentence two.",
            "",
            "## Data",
            "Data sentence one. Data sentence two.",
            "",
            "## Conclusion",
            "Conclusion sentence one. Conclusion sentence two.",
        ].join("\n");

        const chunks = await new SemanticChunker(12).getChunks(input);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.some((chunk) => chunk.includes("# Introduction"))).toBe(true);
        expect(chunks.some((chunk) => chunk.includes("## Data"))).toBe(true);
    });

    test("keeps markdown tables intact when chunking", async () => {
        const input = ["Before.", "| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "After."].join("\n");

        const chunks = await new SemanticChunker(8).getChunks(input);

        expect(chunks.some((chunk) => chunk.includes("| A | B |\n| --- | --- |\n| 1 | 2 |"))).toBe(true);
        expect(chunks.some((chunk) => chunk.includes("After."))).toBe(true);
    });

    test("splits sentences while keeping abbreviations and decimals together", async () => {
        const input = ["Dr. Smith measured 3.14 meters.", "The date is 01.01.2024.", "Another sentence follows."].join(
            " "
        );

        const chunks = await new SemanticChunker(6).getChunks(input);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[0]).toContain("Dr. Smith measured 3.14 meters.");
        expect(chunks.some((chunk) => chunk.includes("01.01.2024."))).toBe(true);
    });
});
