import type { GraphChunker, GraphTextChunk } from "..";

export async function getGraphTextChunks(chunker: GraphChunker, text: string): Promise<GraphTextChunk[]> {
    return chunker.getChunkSpans(text);
}

export function resolveTextChunkSpans(text: string, chunks: string[]): GraphTextChunk[] {
    const spans: GraphTextChunk[] = [];
    let cursor = 0;

    for (const content of chunks) {
        if (content.trim() === "") {
            continue;
        }

        const span = locateChunk(text, content, cursor);
        spans.push({
            content,
            startOffset: span?.startOffset ?? cursor,
            endOffset: span?.endOffset ?? cursor,
        });

        if (span) {
            cursor = span.endOffset;
        }
    }

    return spans;
}

function locateChunk(
    text: string,
    chunk: string,
    cursor: number
): Pick<GraphTextChunk, "startOffset" | "endOffset"> | null {
    const exactStart = text.indexOf(chunk, cursor);
    if (exactStart !== -1) {
        return {
            startOffset: exactStart,
            endOffset: exactStart + chunk.length,
        };
    }

    const trimmed = chunk.trim();
    const trimmedStart = trimmed ? text.indexOf(trimmed, cursor) : -1;
    if (trimmedStart !== -1) {
        return {
            startOffset: trimmedStart,
            endOffset: trimmedStart + trimmed.length,
        };
    }

    const normalized = locateWhitespaceNormalizedChunk(text, chunk, cursor);
    return normalized;
}

function locateWhitespaceNormalizedChunk(
    text: string,
    chunk: string,
    cursor: number
): Pick<GraphTextChunk, "startOffset" | "endOffset"> | null {
    const needle = collapseWhitespace(chunk);
    if (needle === "") {
        return null;
    }

    const index = buildWhitespaceNormalizedIndex(text, cursor);
    const normalizedStart = index.text.indexOf(needle);
    if (normalizedStart === -1) {
        return null;
    }

    const start = index.originalIndexByNormalizedIndex[normalizedStart];
    const end = index.originalIndexByNormalizedIndex[normalizedStart + needle.length - 1];
    if (start === undefined || end === undefined) {
        return null;
    }

    return {
        startOffset: start,
        endOffset: end + 1,
    };
}

function buildWhitespaceNormalizedIndex(
    text: string,
    cursor: number
): {
    text: string;
    originalIndexByNormalizedIndex: number[];
} {
    let normalizedText = "";
    const originalIndexByNormalizedIndex: number[] = [];
    let pendingWhitespaceIndex: number | null = null;

    for (let index = Math.max(0, cursor); index < text.length; index += 1) {
        const char = text[index]!;

        if (/\s/u.test(char)) {
            if (normalizedText.length > 0 && pendingWhitespaceIndex === null) {
                pendingWhitespaceIndex = index;
            }
            continue;
        }

        if (pendingWhitespaceIndex !== null) {
            normalizedText += " ";
            originalIndexByNormalizedIndex.push(pendingWhitespaceIndex);
            pendingWhitespaceIndex = null;
        }

        normalizedText += char;
        originalIndexByNormalizedIndex.push(index);
    }

    return {
        text: normalizedText,
        originalIndexByNormalizedIndex,
    };
}

function collapseWhitespace(value: string): string {
    return value.trim().replace(/\s+/gu, " ");
}
