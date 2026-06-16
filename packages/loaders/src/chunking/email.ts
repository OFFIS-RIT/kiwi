import type { GraphChunker, GraphTextChunk } from "../types";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter } from "./structured";

type EmailChunkerOptions = {
    maxChunkSize: number;
};

type EmailSection = {
    content: string;
};

const EMAIL_MESSAGE_HEADING = /^(?:# Email Message|## Message \d+\b)/u;

export class EmailChunker implements GraphChunker {
    constructor(private readonly options: EmailChunkerOptions) {}

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

        const { preamble, sections } = splitEmailSections(text);
        if (sections.length === 0) {
            return chunkLinesWithPrefix({
                lines: text.split("\n"),
                maxChunkSize: this.options.maxChunkSize,
                tokenCount,
            });
        }

        const chunks: string[] = [];
        let current: EmailSection[] = [];

        const flush = () => {
            if (current.length === 0) {
                return;
            }

            chunks.push(formatEmailChunk(preamble, current));
            current = [];
        };

        for (const section of sections) {
            const sectionChunk = formatEmailChunk(preamble, [section]);
            if (tokenCount(sectionChunk) > this.options.maxChunkSize) {
                flush();
                chunks.push(
                    ...chunkLinesWithPrefix({
                        lines: section.content.split("\n"),
                        prefix: preamble,
                        maxChunkSize: this.options.maxChunkSize,
                        tokenCount,
                    })
                );
                continue;
            }

            const next = [...current, section];
            if (current.length > 0 && tokenCount(formatEmailChunk(preamble, next)) > this.options.maxChunkSize) {
                flush();
            }

            current.push(section);
        }

        flush();
        return chunks.filter((chunk) => chunk.trim() !== "");
    }
}

function splitEmailSections(input: string): { preamble: string; sections: EmailSection[] } {
    const lines = input.split("\n");
    const firstSectionIndex = lines.findIndex((line) => EMAIL_MESSAGE_HEADING.test(line.trim()));
    if (firstSectionIndex < 0) {
        return { preamble: "", sections: [] };
    }

    const preamble = lines.slice(0, firstSectionIndex).join("\n").trim();
    const sections: EmailSection[] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        sections.push({ content: current.join("\n").trim() });
        current = [];
    };

    for (const line of lines.slice(firstSectionIndex)) {
        if (EMAIL_MESSAGE_HEADING.test(line.trim())) {
            flush();
        }

        current.push(line);
    }

    flush();
    return { preamble, sections };
}

function formatEmailChunk(preamble: string, sections: EmailSection[]): string {
    return [preamble, ...sections.map((section) => section.content)]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
}
