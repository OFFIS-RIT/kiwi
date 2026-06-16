import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

export type TokenCount = (text: string) => number;

export function createTokenCounter(): TokenCount {
    const encoder = new Tiktoken(o200k_base);
    const cache = new Map<string, number>();

    return (value: string) => {
        const normalized = value.trim();
        if (normalized === "") {
            return 0;
        }

        const cached = cache.get(normalized);
        if (cached !== undefined) {
            return cached;
        }

        const count = encoder.encode(normalized).length;
        cache.set(normalized, count);
        return count;
    };
}

export function formatPathChunk(path: string, body: string): string {
    const content = body.trim();
    if (path === "$" || path === "") {
        return content;
    }

    return `Path: ${path}\n${content}`;
}

export function chunkLinesWithPrefix(options: {
    lines: string[];
    prefix?: string;
    maxChunkSize: number;
    tokenCount: TokenCount;
}): string[] {
    const prefix = options.prefix?.trim();
    const chunks: string[] = [];
    let current: string[] = [];

    const format = (lines: string[]) => {
        const body = lines.join("\n").trim();
        return prefix ? `${prefix}\n${body}`.trim() : body;
    };

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        chunks.push(format(current));
        current = [];
    };

    for (const line of options.lines) {
        const next = [...current, line];
        if (current.length > 0 && options.tokenCount(format(next)) > options.maxChunkSize) {
            flush();
        }

        if (options.tokenCount(format([line])) > options.maxChunkSize) {
            chunks.push(...chunkLongLine(line, prefix, options.maxChunkSize, options.tokenCount));
            continue;
        }

        current.push(line);
    }

    flush();
    return chunks.filter((chunk) => chunk.trim() !== "");
}

function chunkLongLine(
    line: string,
    prefix: string | undefined,
    maxChunkSize: number,
    tokenCount: TokenCount
): string[] {
    const words = line.split(/(\s+)/u).filter((part) => part !== "");
    if (words.length <= 1) {
        return chunkByCharacterWindow(line, prefix, maxChunkSize, tokenCount);
    }

    const chunks: string[] = [];
    let current = "";

    const format = (value: string) => (prefix ? `${prefix}\n${value}`.trim() : value.trim());

    for (const word of words) {
        const next = `${current}${word}`;
        if (current !== "" && tokenCount(format(next)) > maxChunkSize) {
            chunks.push(format(current));
            current = "";
        }

        if (tokenCount(format(word)) > maxChunkSize) {
            chunks.push(...chunkByCharacterWindow(word, prefix, maxChunkSize, tokenCount));
            continue;
        }

        current += word;
    }

    if (current.trim() !== "") {
        chunks.push(format(current));
    }

    return chunks;
}

function chunkByCharacterWindow(
    value: string,
    prefix: string | undefined,
    maxChunkSize: number,
    tokenCount: TokenCount
): string[] {
    const chunks: string[] = [];
    const format = (chunk: string) => (prefix ? `${prefix}\n${chunk}`.trim() : chunk.trim());
    let start = 0;
    let windowSize = Math.max(128, maxChunkSize * 3);

    while (start < value.length) {
        let end = Math.min(value.length, start + windowSize);
        while (end > start + 1 && tokenCount(format(value.slice(start, end))) > maxChunkSize) {
            windowSize = Math.max(1, Math.floor(windowSize * 0.75));
            end = Math.min(value.length, start + windowSize);
        }

        chunks.push(format(value.slice(start, end)));
        start = end;
    }

    return chunks;
}
