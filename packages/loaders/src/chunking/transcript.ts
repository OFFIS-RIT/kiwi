import type { GraphChunker, GraphTextChunk } from "../types";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter } from "./structured";

type TranscriptChunkerOptions = {
    maxChunkSize: number;
};

type TranscriptSection = {
    heading: string;
    content: string;
};

const TRANSCRIPT_SEGMENT_HEADING = /^## Segment \d+\b/u;

export class TranscriptChunker implements GraphChunker {
    constructor(private readonly options: TranscriptChunkerOptions) {}

    async getChunks(input: string): Promise<string[]> {
        return (await this.getChunkSpans(input)).map((chunk) => chunk.content);
    }

    async getChunkSpans(input: string): Promise<GraphTextChunk[]> {
        return resolveTextChunkSpans(input, await this.getChunkContents(input));
    }

    private async getChunkContents(input: string): Promise<string[]> {
        const text = input.trim();
        if (text === "") {
            return [];
        }

        const tokenCount = createTokenCounter();
        if (tokenCount(text) <= this.options.maxChunkSize) {
            return [text];
        }

        const { preamble, sections } = splitTranscript(text);
        if (sections.length === 0) {
            return chunkLinesWithPrefix({
                lines: text.split("\n"),
                maxChunkSize: this.options.maxChunkSize,
                tokenCount,
            });
        }

        const chunks: string[] = [];
        let current: TranscriptSection[] = [];

        const flush = () => {
            if (current.length === 0) {
                return;
            }

            chunks.push(formatTranscriptChunk(preamble, current));
            current = [];
        };

        for (const section of sections) {
            const sectionChunk = formatTranscriptChunk(preamble, [section]);

            if (tokenCount(sectionChunk) > this.options.maxChunkSize) {
                flush();
                chunks.push(...splitLargeSection(preamble, section, this.options.maxChunkSize, tokenCount));
                continue;
            }

            const next = [...current, section];
            if (current.length > 0 && tokenCount(formatTranscriptChunk(preamble, next)) > this.options.maxChunkSize) {
                flush();
            }

            current.push(section);
        }

        flush();
        return chunks.filter((chunk) => chunk.trim() !== "");
    }
}

function splitTranscript(input: string): { preamble: string; sections: TranscriptSection[] } {
    const lines = input.split("\n");
    const firstSectionIndex = lines.findIndex((line) => TRANSCRIPT_SEGMENT_HEADING.test(line.trim()));

    if (firstSectionIndex < 0) {
        return { preamble: "", sections: [] };
    }

    const preamble = lines.slice(0, firstSectionIndex).join("\n").trim();
    const sections: TranscriptSection[] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        sections.push({
            heading: current[0]!.trim(),
            content: current.join("\n").trim(),
        });
        current = [];
    };

    for (const line of lines.slice(firstSectionIndex)) {
        if (TRANSCRIPT_SEGMENT_HEADING.test(line.trim())) {
            flush();
        }

        current.push(line);
    }

    flush();
    return { preamble, sections };
}

function formatTranscriptChunk(preamble: string, sections: TranscriptSection[]): string {
    return [preamble, ...sections.map((section) => section.content)]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function splitLargeSection(
    preamble: string,
    section: TranscriptSection,
    maxChunkSize: number,
    tokenCount: ReturnType<typeof createTokenCounter>
): string[] {
    const lines = section.content.split("\n");
    const bodyStart = lines.findIndex((line, index) => index > 0 && line.trim() === "");

    if (bodyStart < 0) {
        return chunkLinesWithPrefix({
            lines,
            prefix: preamble,
            maxChunkSize,
            tokenCount,
        });
    }

    const sectionPrefix = [preamble, lines.slice(0, bodyStart).join("\n").trim()]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n");
    const bodyLines = lines.slice(bodyStart + 1);

    return chunkLinesWithPrefix({
        lines: bodyLines,
        prefix: sectionPrefix,
        maxChunkSize,
        tokenCount,
    });
}
