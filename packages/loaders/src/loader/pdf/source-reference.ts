import type { LoadedGraphDocument, LoaderSourceChunk, SourceChunkRegion } from "../../types";
import { renderPageFence } from "../../lib/page-fence";
import { DEFAULT_SOURCE_CHUNK_TOKENS } from "../../lib/source-chunk";
import type { PDFPageGeometry } from "./page-geometry";
import type { BoundingBox } from "./types";

export type PDFPageContentEntry = {
    type: "text" | "image";
    text: string;
    sourceText?: string;
    imageId?: string;
    region: SourceChunkRegion;
};

export type PDFMaterializedPageContentEntry = PDFPageContentEntry & {
    startOffset: number;
    endOffset: number;
};

export class PDFDocumentBuilder {
    private text = "";
    private readonly sourceChunks: LoaderSourceChunk[] = [];

    appendPage(pageIndex: number, content: string, chunks: LoaderSourceChunk[]): void {
        const trimmedContent = content.trim();
        if (trimmedContent === "") {
            return;
        }

        if (this.text !== "") {
            this.text += "\n\n";
        }

        this.text += `${renderPageFence(pageIndex + 1)}\n\n`;
        const contentStart = this.text.length;
        this.text += trimmedContent;

        for (const chunk of chunks) {
            this.sourceChunks.push({
                ...chunk,
                startOffset: contentStart + chunk.startOffset,
                endOffset: contentStart + chunk.endOffset,
            });
        }
    }

    build(): LoadedGraphDocument {
        return {
            text: this.text,
            sourceChunks: this.sourceChunks,
        };
    }
}

export function materializePageEntries(
    entries: PDFPageContentEntry[],
    separator: string
): { content: string; entries: PDFMaterializedPageContentEntry[] } {
    let content = "";
    const materialized: PDFMaterializedPageContentEntry[] = [];

    for (const entry of entries) {
        const text = entry.text.trim();
        if (text === "") {
            continue;
        }

        if (content !== "") {
            content += separator;
        }

        const startOffset = content.length;
        content += text;
        materialized.push({
            ...entry,
            text,
            startOffset,
            endOffset: content.length,
        });
    }

    return { content, entries: materialized };
}

export function sourceChunksForMaterializedEntries(entries: PDFMaterializedPageContentEntry[]): LoaderSourceChunk[] {
    const chunks: LoaderSourceChunk[] = [];
    let pendingTextEntries: PDFMaterializedPageContentEntry[] = [];

    const flushText = () => {
        chunks.push(...groupTextEntries(pendingTextEntries));
        pendingTextEntries = [];
    };

    for (const entry of entries) {
        if (entry.type === "text") {
            pendingTextEntries.push(entry);
            continue;
        }

        flushText();
        chunks.push({
            type: "image",
            text: entry.sourceText ?? entry.text,
            imageId: entry.imageId ?? null,
            imageKey: null,
            startPage: entry.region.page,
            endPage: entry.region.page,
            regions: [entry.region],
            startOffset: entry.startOffset,
            endOffset: entry.endOffset,
        });
    }

    flushText();
    return chunks;
}

export function sourceChunksForWholePageText(text: string, geometry: PDFPageGeometry): LoaderSourceChunk[] {
    const chunks: LoaderSourceChunk[] = [];
    let startOffset: number | null = null;
    let endOffset = 0;
    let groupTokens = 0;

    const flush = () => {
        if (startOffset === null) {
            return;
        }

        const chunkText = text.slice(startOffset, endOffset).trim();
        if (chunkText !== "") {
            chunks.push({
                type: "text",
                text: chunkText,
                startPage: geometry.pageNumber,
                endPage: geometry.pageNumber,
                regions: [wholePageRegion(geometry)],
                startOffset,
                endOffset,
            });
        }

        startOffset = null;
        endOffset = 0;
        groupTokens = 0;
    };

    for (const match of text.matchAll(/\S+/gu)) {
        const word = match[0];
        const wordStart = match.index ?? 0;
        const wordEnd = wordStart + word.length;
        const wordTokens = estimateTokens(word);

        if (startOffset !== null && groupTokens + wordTokens > DEFAULT_SOURCE_CHUNK_TOKENS) {
            flush();
        }

        startOffset ??= wordStart;
        endOffset = wordEnd;
        groupTokens += wordTokens;
    }

    flush();
    return chunks;
}

export function regionForBoundingBox(
    kind: SourceChunkRegion["kind"],
    geometry: PDFPageGeometry,
    bbox: BoundingBox
): SourceChunkRegion | null {
    const rectangle = toRegionRect(bbox, geometry);
    if (!rectangle) {
        return null;
    }

    return {
        kind,
        page: geometry.pageNumber,
        width: geometry.renderedWidth,
        height: geometry.renderedHeight,
        rectangles: [rectangle],
    };
}

export function extractImageFenceId(text: string): string | null {
    return /:::IMG-([^:]+):::/u.exec(text)?.[1] ?? null;
}

export function renderImageTag(id: string, description: string): string {
    return `<image id="${escapeXml(id)}">${escapeXml(description)}</image>`;
}

function groupTextEntries(entries: PDFMaterializedPageContentEntry[]): LoaderSourceChunk[] {
    const chunks: LoaderSourceChunk[] = [];
    let group: PDFMaterializedPageContentEntry[] = [];
    let groupTokens = 0;

    const flush = () => {
        if (group.length === 0) {
            return;
        }

        const first = group[0]!;
        const last = group[group.length - 1]!;
        chunks.push({
            type: "text",
            text: group.map((entry) => entry.sourceText ?? entry.text).join("\n\n"),
            startPage: first.region.page,
            endPage: last.region.page,
            regions: [regionForEntries("text", group)],
            startOffset: first.startOffset,
            endOffset: last.endOffset,
        });
        group = [];
        groupTokens = 0;
    };

    for (const entry of entries) {
        const tokens = estimateTokens(entry.sourceText ?? entry.text);
        if (group.length > 0 && groupTokens + tokens > DEFAULT_SOURCE_CHUNK_TOKENS) {
            flush();
        }

        group.push(entry);
        groupTokens += tokens;
    }

    flush();
    return chunks;
}

function regionForEntries(
    kind: SourceChunkRegion["kind"],
    entries: PDFMaterializedPageContentEntry[]
): SourceChunkRegion {
    const first = entries[0]!;
    const width = first.region.width;
    const height = first.region.height;

    return {
        kind,
        page: first.region.page,
        width,
        height,
        rectangles: entries.flatMap((entry) => entry.region.rectangles),
    };
}

function wholePageRegion(geometry: PDFPageGeometry): SourceChunkRegion {
    return {
        kind: "page",
        page: geometry.pageNumber,
        width: geometry.renderedWidth,
        height: geometry.renderedHeight,
        rectangles: [{ left: 0, top: 0, width: 1, height: 1 }],
    };
}

// Maps a bbox in unrotated PDF user space (origin bottom-left) onto the
// rasterized page image (origin top-left, /Rotate applied, renderBox cropped).
function toRegionRect(bbox: BoundingBox, geometry: PDFPageGeometry): SourceChunkRegion["rectangles"][number] | null {
    const { renderBox, rotation, renderedWidth, renderedHeight } = geometry;
    const x0 = bbox.x - renderBox.x;
    const x1 = x0 + bbox.width;
    const y0 = bbox.y - renderBox.y;
    const y1 = y0 + bbox.height;

    let left: number;
    let top: number;
    let width: number;
    let height: number;
    switch (rotation) {
        case 90:
            left = y0;
            top = x0;
            width = y1 - y0;
            height = x1 - x0;
            break;
        case 180:
            left = renderBox.width - x1;
            // The y-axis flip and 180-degree page rotation cancel out, so top stays relative to PDF y.
            top = y0;
            width = x1 - x0;
            height = y1 - y0;
            break;
        case 270:
            left = renderBox.height - y1;
            top = renderBox.width - x1;
            width = y1 - y0;
            height = x1 - x0;
            break;
        default:
            left = x0;
            top = renderBox.height - y1;
            width = x1 - x0;
            height = y1 - y0;
            break;
    }

    const clippedLeft = Math.max(0, left);
    const clippedTop = Math.max(0, top);
    const clippedRight = Math.min(renderedWidth, left + width);
    const clippedBottom = Math.min(renderedHeight, top + height);
    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) {
        return null;
    }

    return {
        left: clampRatio(clippedLeft / renderedWidth),
        top: clampRatio(clippedTop / renderedHeight),
        width: clampRatio((clippedRight - clippedLeft) / renderedWidth),
        height: clampRatio((clippedBottom - clippedTop) / renderedHeight),
    };
}

function escapeXml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

function estimateTokens(text: string): number {
    const words = text.trim().match(/\S+/gu)?.length ?? 0;
    return Math.max(1, Math.ceil(words * 1.35));
}

function clampRatio(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(1, value));
}
