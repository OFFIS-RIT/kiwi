import type { LoadedGraphDocument, LoaderSourceChunk, SourceChunkRegion } from "../..";
import { renderPageFence } from "../../lib/page-fence";
import { DEFAULT_SOURCE_CHUNK_TOKENS } from "../../lib/source-chunk";
import { getTop } from "./geometry";
import type { BoundingBox, PDFPageLike } from "./types";

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

export function sourceChunksForMaterializedEntries(
    entries: PDFMaterializedPageContentEntry[]
): LoaderSourceChunk[] {
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

export function sourceChunksForWholePageText(
    text: string,
    page: Pick<PDFPageLike, "index" | "width" | "height">
): LoaderSourceChunk[] {
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
                startPage: page.index + 1,
                endPage: page.index + 1,
                regions: [wholePageRegion(page)],
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
    page: number,
    width: number,
    height: number,
    bbox: BoundingBox
): SourceChunkRegion {
    return {
        kind,
        page,
        width,
        height,
        rectangles: [toRegionRect(bbox, width, height)],
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

function wholePageRegion(page: Pick<PDFPageLike, "index" | "width" | "height">): SourceChunkRegion {
    return {
        kind: "page",
        page: page.index + 1,
        width: page.width,
        height: page.height,
        rectangles: [{ left: 0, top: 0, width: 1, height: 1 }],
    };
}

function toRegionRect(
    bbox: BoundingBox,
    pageWidth: number,
    pageHeight: number
): SourceChunkRegion["rectangles"][number] {
    return {
        left: clampRatio(bbox.x / pageWidth),
        top: clampRatio((pageHeight - getTop(bbox)) / pageHeight),
        width: clampRatio(bbox.width / pageWidth),
        height: clampRatio(bbox.height / pageHeight),
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
