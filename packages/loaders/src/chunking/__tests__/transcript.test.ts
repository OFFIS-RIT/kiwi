import { describe, expect, test } from "bun:test";
import { TranscriptChunker } from "../transcript";

describe("TranscriptChunker", () => {
    test("returns no chunks for empty input", async () => {
        const chunks = await new TranscriptChunker({ maxChunkSize: 100 }).getChunks("");

        expect(chunks).toEqual([]);
    });

    test("groups transcript segments while preserving transcript metadata", async () => {
        const input = [
            "# Audio Transcript",
            "",
            "- Language: en",
            "- Duration: 00:00:10.000",
            "",
            "## Segment 1",
            "- Time: 00:00:00.000 --> 00:00:05.000",
            "- Speaker: Alice",
            "",
            "Alpha ".repeat(80),
            "",
            "## Segment 2",
            "- Time: 00:00:05.000 --> 00:00:10.000",
            "- Speaker: Bob",
            "",
            "Beta ".repeat(80),
        ].join("\n");

        const chunks = await new TranscriptChunker({ maxChunkSize: 50 }).getChunks(input);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.startsWith("# Audio Transcript"))).toBe(true);
        expect(chunks.some((chunk) => chunk.includes("## Segment 1"))).toBe(true);
        expect(chunks.some((chunk) => chunk.includes("## Segment 2"))).toBe(true);
    });

    test("falls back to line chunking when transcript segment headings are missing", async () => {
        const input = [
            "# Audio Transcript",
            "",
            "- Time: unknown",
            "- Speaker: Speaker unknown",
            "",
            Array.from({ length: 80 }, (_, index) => `Loose transcript sentence ${index}.`).join("\n"),
        ].join("\n");

        const chunks = await new TranscriptChunker({ maxChunkSize: 40 }).getChunks(input);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join("\n")).toContain("Loose transcript sentence 0.");
        expect(chunks.join("\n")).toContain("Loose transcript sentence 79.");
    });

    test("returns exact source spans for transcripts that fit in one chunk", async () => {
        const input = [
            "# Audio Transcript",
            "",
            "## Segment 1",
            "- Time: unknown",
            "- Speaker: Speaker unknown",
            "",
            "A short transcript.",
        ].join("\n");

        const spans = await new TranscriptChunker({ maxChunkSize: 100 }).getChunkSpans(`\n${input}\n`);

        expect(spans).toEqual([
            {
                content: input,
                startOffset: 1,
                endOffset: input.length + 1,
            },
        ]);
    });

    test("repeats segment speaker and time metadata for split long segments", async () => {
        const input = [
            "# Audio Transcript",
            "",
            "## Segment 1",
            "- Time: 00:00:00.000 --> 00:01:00.000",
            "- Speaker: Alice",
            "",
            Array.from({ length: 80 }, (_, index) => `Sentence ${index}.`).join(" "),
        ].join("\n");

        const chunks = await new TranscriptChunker({ maxChunkSize: 35 }).getChunks(input);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.includes("## Segment 1"))).toBe(true);
        expect(chunks.every((chunk) => chunk.includes("- Speaker: Alice"))).toBe(true);
        expect(chunks.every((chunk) => chunk.includes("- Time: 00:00:00.000 --> 00:01:00.000"))).toBe(true);
    });
});
