import type { GraphChunker, GraphTextChunk } from "..";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter, type TokenCount } from "./structured";

type TOMLChunkerOptions = {
    maxChunkSize: number;
};

type TOMLSection = {
    lines: string[];
    headerIndex: number;
    path: string;
};

export class TOMLChunker implements GraphChunker {
    private readonly maxChunkSize: number;

    constructor(options: TOMLChunkerOptions) {
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
        return this.chunkSections(splitTOMLSections(lines), tokenCount);
    }

    private chunkSections(sections: TOMLSection[], tokenCount: TokenCount): string[] {
        const chunks: string[] = [];
        let currentLines: string[] = [];

        const flush = () => {
            if (currentLines.length === 0) {
                return;
            }

            chunks.push(currentLines.join("\n").trim());
            currentLines = [];
        };

        for (const section of sections) {
            const sectionText = section.lines.join("\n").trim();
            if (tokenCount(sectionText) > this.maxChunkSize) {
                flush();
                chunks.push(...this.chunkOversizedSection(section, tokenCount));
                continue;
            }

            const nextText = [...currentLines, ...section.lines].join("\n").trim();
            if (currentLines.length > 0 && tokenCount(nextText) > this.maxChunkSize) {
                flush();
            }

            currentLines.push(...section.lines);
        }

        flush();
        return chunks;
    }

    private chunkOversizedSection(section: TOMLSection, tokenCount: TokenCount): string[] {
        const contextLines = section.lines.slice(0, section.headerIndex + 1);
        const bodyLines = section.lines.slice(section.headerIndex + 1);
        const entries = splitTOMLEntries(bodyLines);

        if (entries.length <= 1) {
            return chunkLinesWithPrefix({
                lines: bodyLines.length > 0 ? bodyLines : section.lines,
                prefix: formatTOMLPrefix(section.path, contextLines),
                maxChunkSize: this.maxChunkSize,
                tokenCount,
            });
        }

        const chunks: string[] = [];
        let currentEntries: string[] = [];

        const flush = () => {
            if (currentEntries.length === 0) {
                return;
            }

            chunks.push(formatTOMLChunk(section.path, contextLines, currentEntries));
            currentEntries = [];
        };

        for (const entry of entries) {
            const entryText = formatTOMLChunk(section.path, contextLines, entry);
            if (tokenCount(entryText) > this.maxChunkSize) {
                flush();
                chunks.push(
                    ...chunkLinesWithPrefix({
                        lines: entry,
                        prefix: formatTOMLPrefix(section.path, contextLines),
                        maxChunkSize: this.maxChunkSize,
                        tokenCount,
                    })
                );
                continue;
            }

            const nextEntries = [...currentEntries, ...entry];
            const nextText = formatTOMLChunk(section.path, contextLines, nextEntries);
            if (currentEntries.length > 0 && tokenCount(nextText) > this.maxChunkSize) {
                flush();
            }

            currentEntries.push(...entry);
        }

        flush();
        return chunks;
    }
}

function splitTOMLSections(lines: string[]): TOMLSection[] {
    const sections: TOMLSection[] = [];
    let start = 0;
    let headerIndex = -1;
    let path = "$";

    const push = (end: number) => {
        if (end <= start) {
            return;
        }

        sections.push({
            lines: lines.slice(start, end),
            headerIndex: headerIndex >= start ? headerIndex - start : -1,
            path,
        });
    };

    for (let index = 0; index < lines.length; index += 1) {
        const headerPath = readTOMLHeaderPath(lines[index]!);
        if (!headerPath) {
            continue;
        }

        push(index);
        start = index;
        headerIndex = index;
        path = headerPath;
    }

    push(lines.length);
    return sections.length > 0 ? sections : [{ lines, headerIndex: -1, path: "$" }];
}

function splitTOMLEntries(lines: string[]): string[][] {
    const entries: string[][] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        entries.push(current);
        current = [];
    };

    for (const line of lines) {
        if (isTOMLEntryStart(line) && current.some((currentLine) => currentLine.trim() !== "")) {
            flush();
        }

        current.push(line);
    }

    flush();
    return entries;
}

function readTOMLHeaderPath(line: string): string | null {
    const trimmed = line.trim();
    const arrayMatch = /^\[\[\s*([^\]]+?)\s*\]\]$/u.exec(trimmed);
    if (arrayMatch?.[1]) {
        return tomlPath(arrayMatch[1], true);
    }

    const tableMatch = /^\[\s*([^\]]+?)\s*\]$/u.exec(trimmed);
    if (tableMatch?.[1]) {
        return tomlPath(tableMatch[1], false);
    }

    return null;
}

function tomlPath(rawPath: string, array: boolean): string {
    const segments = splitTOMLPath(rawPath)
        .map((segment) => cleanTOMLSegment(segment))
        .filter((segment) => segment !== "");
    const path = segments.reduce((current, segment) => appendPath(current, segment), "$");
    return array ? `${path}[]` : path;
}

function splitTOMLPath(rawPath: string): string[] {
    const segments: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (const char of rawPath) {
        if (quote) {
            current += char;

            if (quote === '"' && char === "\\" && !escaped) {
                escaped = true;
                continue;
            }

            if (char === quote && !escaped) {
                quote = null;
            }

            escaped = false;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }

        if (char === ".") {
            segments.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    segments.push(current);
    return segments;
}

function cleanTOMLSegment(segment: string): string {
    const trimmed = segment.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

function appendPath(parentPath: string, segment: string): string {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segment)) {
        return parentPath === "$" ? `$.${segment}` : `${parentPath}.${segment}`;
    }

    const quoted = segment.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `${parentPath}["${quoted}"]`;
}

function isTOMLEntryStart(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("[")) {
        return false;
    }

    return /^(?:"(?:[^"\\]|\\.)+"|'[^']+'|[A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=/u.test(trimmed);
}

function formatTOMLChunk(path: string, contextLines: string[], bodyLines: string[]): string {
    const prefix = formatTOMLPrefix(path, contextLines);
    const body = bodyLines.join("\n").trim();
    return prefix ? `${prefix}\n${body}`.trim() : body;
}

function formatTOMLPrefix(path: string, contextLines: string[]): string | undefined {
    const parts: string[] = [];
    if (path !== "$") {
        parts.push(`Path: ${path}`);
    }

    const context = contextLines.join("\n").trim();
    if (context !== "") {
        parts.push(context);
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
}
