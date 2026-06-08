import type { GraphChunker, GraphTextChunk } from "..";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter, type TokenCount } from "./structured";

type YAMLChunkerOptions = {
    maxChunkSize: number;
};

type YAMLBlock = {
    lines: string[];
    path: string;
};

export class YAMLChunker implements GraphChunker {
    private readonly maxChunkSize: number;

    constructor(options: YAMLChunkerOptions) {
        this.maxChunkSize = options.maxChunkSize;
    }

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
        if (tokenCount(text) <= this.maxChunkSize) {
            return [text];
        }

        const lines = text.split(/\r?\n/u);
        return this.chunkLines(lines, "$", findBaseIndent(lines) ?? 0, [], tokenCount);
    }

    private chunkLines(
        lines: string[],
        path: string,
        indent: number,
        contextLines: string[],
        tokenCount: TokenCount
    ): string[] {
        const formatted = formatYAMLChunk(path, contextLines, lines);
        if (tokenCount(formatted) <= this.maxChunkSize) {
            return [formatted];
        }

        const blocks = splitYAMLBlocks(lines, indent, path);
        if (blocks.length === 0) {
            return this.chunkLongLines(lines, path, contextLines, tokenCount);
        }

        if (blocks.length === 1) {
            return this.chunkOversizedBlock(blocks[0]!, indent, contextLines, tokenCount);
        }

        const chunks: string[] = [];
        let currentLines: string[] = [];

        const flush = () => {
            if (currentLines.length === 0) {
                return;
            }

            chunks.push(formatYAMLChunk(path, contextLines, currentLines));
            currentLines = [];
        };

        for (const block of blocks) {
            const blockText = formatYAMLChunk(path, contextLines, block.lines);
            if (tokenCount(blockText) > this.maxChunkSize) {
                flush();
                chunks.push(...this.chunkOversizedBlock(block, indent, contextLines, tokenCount));
                continue;
            }

            const nextLines = [...currentLines, ...block.lines];
            const nextText = formatYAMLChunk(path, contextLines, nextLines);
            if (currentLines.length > 0 && tokenCount(nextText) > this.maxChunkSize) {
                flush();
            }

            currentLines.push(...block.lines);
        }

        flush();
        return chunks;
    }

    private chunkOversizedBlock(
        block: YAMLBlock,
        indent: number,
        contextLines: string[],
        tokenCount: TokenCount
    ): string[] {
        const nestedIndent = findNestedIndent(block.lines, indent);
        if (nestedIndent !== null) {
            const nestedStart = firstSignificantLineAtIndent(block.lines, nestedIndent);
            if (nestedStart > 0) {
                return this.chunkLines(
                    block.lines.slice(nestedStart),
                    block.path,
                    nestedIndent,
                    [...contextLines, ...block.lines.slice(0, nestedStart)],
                    tokenCount
                );
            }
        }

        return this.chunkLongLines(block.lines, block.path, contextLines, tokenCount);
    }

    private chunkLongLines(lines: string[], path: string, contextLines: string[], tokenCount: TokenCount): string[] {
        return chunkLinesWithPrefix({
            lines,
            prefix: formatYAMLPrefix(path, contextLines),
            maxChunkSize: this.maxChunkSize,
            tokenCount,
        });
    }
}

function splitYAMLBlocks(lines: string[], indent: number, parentPath: string): YAMLBlock[] {
    const starts: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (isYAMLStructuralLine(line, indent)) {
            starts.push(index);
        }
    }

    if (starts.length === 0) {
        return [];
    }

    return starts.map((start, index) => {
        const end = starts[index + 1] ?? lines.length;
        const blockStart = index === 0 ? 0 : start;
        const blockLines = lines.slice(blockStart, end);
        return {
            lines: blockLines,
            path: deriveYAMLPath(parentPath, lines[start]!, index),
        };
    });
}

function isYAMLStructuralLine(line: string, indent: number): boolean {
    return isSignificantYAMLLine(line) && indentation(line) === indent;
}

function isSignificantYAMLLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
}

function deriveYAMLPath(parentPath: string, line: string, blockIndex: number): string {
    const trimmed = line.trim();
    if (trimmed.startsWith("-")) {
        const afterDash = trimmed.slice(1).trim();
        const itemPath = appendPath(parentPath, `[${blockIndex}]`);
        const key = readYAMLKey(afterDash);
        return key ? appendPath(itemPath, key) : itemPath;
    }

    return appendPath(parentPath, readYAMLKey(trimmed) ?? `section${blockIndex + 1}`);
}

function readYAMLKey(value: string): string | null {
    const match = /^(?:"([^"]+)"|'([^']+)'|([^:[\]{}\s][^:#]*?))\s*:/u.exec(value);
    const key = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
    return key || null;
}

function appendPath(parentPath: string, segment: string): string {
    if (segment.startsWith("[")) {
        return `${parentPath}${segment}`;
    }

    if (/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segment)) {
        return parentPath === "$" ? `$.${segment}` : `${parentPath}.${segment}`;
    }

    const quoted = segment.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `${parentPath}["${quoted}"]`;
}

function findBaseIndent(lines: string[]): number | null {
    const indents = lines.filter(isSignificantYAMLLine).map(indentation);
    return indents.length > 0 ? Math.min(...indents) : null;
}

function findNestedIndent(lines: string[], indent: number): number | null {
    const nested = lines
        .filter(isSignificantYAMLLine)
        .map(indentation)
        .filter((lineIndent) => lineIndent > indent);
    return nested.length > 0 ? Math.min(...nested) : null;
}

function firstSignificantLineAtIndent(lines: string[], indent: number): number {
    const index = lines.findIndex((line) => isSignificantYAMLLine(line) && indentation(line) >= indent);
    return index >= 0 ? index : lines.length;
}

function indentation(line: string): number {
    return line.match(/^\s*/u)?.[0].length ?? 0;
}

function formatYAMLChunk(path: string, contextLines: string[], bodyLines: string[]): string {
    const prefix = formatYAMLPrefix(path, contextLines);
    const body = bodyLines.join("\n").trim();
    return prefix ? `${prefix}\n${body}`.trim() : body;
}

function formatYAMLPrefix(path: string, contextLines: string[]): string | undefined {
    const parts: string[] = [];
    if (path !== "$") {
        parts.push(`Path: ${path}`);
    }

    const context = contextLines.join("\n").trim();
    if (context !== "") {
        parts.push(`Context:\n${context}`);
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
}
