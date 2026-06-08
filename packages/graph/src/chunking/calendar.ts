import type { GraphChunker, GraphTextChunk } from "..";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter } from "./structured";

type CalendarChunkerOptions = {
    maxChunkSize: number;
};

const CALENDAR_SECTION_HEADING = /^## (?:Event|Todo|Journal) \d+\b/u;

export class CalendarChunker implements GraphChunker {
    constructor(private readonly options: CalendarChunkerOptions) {}

    async getChunks(input: string): Promise<string[]> {
        return (await this.getChunkSpans(input)).map((chunk) => chunk.content);
    }

    async getChunkSpans(input: string): Promise<GraphTextChunk[]> {
        return resolveTextChunkSpans(input, await chunkRecordSections(input, CALENDAR_SECTION_HEADING, this.options.maxChunkSize));
    }
}

async function chunkRecordSections(input: string, heading: RegExp, maxChunkSize: number): Promise<string[]> {
    const text = input.trim();
    if (text === "") {
        return [];
    }

    const tokenCount = createTokenCounter();
    if (tokenCount(text) <= maxChunkSize) {
        return [text];
    }

    const sections = splitSections(text, heading);
    if (sections.records.length === 0) {
        return chunkLinesWithPrefix({ lines: text.split("\n"), maxChunkSize, tokenCount });
    }

    return sections.records.flatMap((record) =>
        tokenCount(record) <= maxChunkSize
            ? [formatRecordChunk(sections.preamble, record)]
            : chunkLinesWithPrefix({ lines: record.split("\n"), prefix: sections.preamble, maxChunkSize, tokenCount })
    );
}

function splitSections(input: string, heading: RegExp): { preamble: string; records: string[] } {
    const lines = input.split("\n");
    const firstRecordIndex = lines.findIndex((line) => heading.test(line.trim()));
    if (firstRecordIndex < 0) {
        return { preamble: "", records: [] };
    }

    const preamble = lines.slice(0, firstRecordIndex).join("\n").trim();
    const records: string[] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length > 0) {
            records.push(current.join("\n").trim());
            current = [];
        }
    };

    for (const line of lines.slice(firstRecordIndex)) {
        if (heading.test(line.trim())) {
            flush();
        }
        current.push(line);
    }

    flush();
    return { preamble, records };
}

function formatRecordChunk(preamble: string, record: string): string {
    return [preamble, record].map((part) => part.trim()).filter(Boolean).join("\n\n");
}
