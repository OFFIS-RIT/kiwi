import type { GraphChunker, GraphTextChunk } from "../types";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter } from "./structured";

type VCardChunkerOptions = {
    maxChunkSize: number;
};

const VCARD_SECTION_HEADING = /^## Contact \d+\b/u;

export class VCardChunker implements GraphChunker {
    constructor(private readonly options: VCardChunkerOptions) {}

    async getChunks(input: string): Promise<string[]> {
        return (await this.getChunkSpans(input)).map((chunk) => chunk.content);
    }

    async getChunkSpans(input: string): Promise<GraphTextChunk[]> {
        const text = input.trim();
        if (text === "") {
            return [];
        }

        const tokenCount = createTokenCounter();
        if (tokenCount(text) <= this.options.maxChunkSize) {
            return resolveTextChunkSpans(input, [text]);
        }

        const lines = text.split("\n");
        const firstContactIndex = lines.findIndex((line) => VCARD_SECTION_HEADING.test(line.trim()));
        if (firstContactIndex < 0) {
            const chunks = chunkLinesWithPrefix({
                lines,
                maxChunkSize: this.options.maxChunkSize,
                tokenCount,
            });
            return resolveTextChunkSpans(input, chunks);
        }

        const preamble = lines.slice(0, firstContactIndex).join("\n").trim();
        const chunks = chunkContacts(lines.slice(firstContactIndex), preamble, this.options.maxChunkSize, tokenCount);
        return resolveTextChunkSpans(input, chunks);
    }
}

function chunkContacts(
    lines: string[],
    preamble: string,
    maxChunkSize: number,
    tokenCount: ReturnType<typeof createTokenCounter>
): string[] {
    const chunks: string[] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        const contact = current.join("\n").trim();
        const chunk = [preamble, contact].filter(Boolean).join("\n\n");
        if (tokenCount(chunk) <= maxChunkSize) {
            chunks.push(chunk);
        } else {
            chunks.push(...chunkLinesWithPrefix({ lines: current, prefix: preamble, maxChunkSize, tokenCount }));
        }
        current = [];
    };

    for (const line of lines) {
        if (VCARD_SECTION_HEADING.test(line.trim())) {
            flush();
        }
        current.push(line);
    }

    flush();
    return chunks;
}
