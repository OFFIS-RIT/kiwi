import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { LoadedGraphDocument, LoaderSourceChunk, SourceChunkRegion } from "../..";
import { describeOCRImages } from "../../lib/ocr-image";
import { DEFAULT_SOURCE_CHUNK_TOKENS } from "../../lib/source-chunk";
import type {
    BoundingBox,
    FullOCRDeps,
    ImageOccurrence,
    PageContentAnalysis,
    PDFDocumentLike,
    PDFOCRImage,
    PDFParserOptions,
    PDFPageLike,
    PreparedPage,
    RenderBlock,
} from "./types";
import { renderPageFence } from "../../lib/page-fence";
import { analyzePageContent } from "./content";
import { extractOCRTextFromPDFPages } from "./ocr";
import { getTop } from "./geometry";
import { findRepeatedEdgeLinePatterns, renderPageBlocks } from "./render";
import { applyActualTextToPageText, getLineText, inferLineDirection, tidyPageText } from "./text";

type PDFHybridOCRFallbackOptions = Pick<FullOCRDeps, "rasterizeSelectedPages" | "transcribePage"> & {
    content: Uint8Array;
    model: LanguageModelV3;
};

type PDFDocumentExtractionOptions = PDFParserOptions & {
    mode?: "plain" | "hybrid";
    ocrFallback?: PDFHybridOCRFallbackOptions;
};

type LocalSourceChunk = LoaderSourceChunk;

type PageContentEntry = {
    type: "text" | "image";
    text: string;
    sourceText?: string;
    imageId?: string;
    region: SourceChunkRegion;
};

type MaterializedPageContentEntry = PageContentEntry & {
    startOffset: number;
    endOffset: number;
};

class PDFDocumentBuilder {
    private text = "";
    private readonly sourceChunks: LoaderSourceChunk[] = [];

    appendPage(pageIndex: number, content: string, chunks: LocalSourceChunk[]): void {
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

export async function extractPDFDocumentFromDocument(
    pdf: PDFDocumentLike,
    options: PDFDocumentExtractionOptions = {}
): Promise<LoadedGraphDocument> {
    const mode = options.mode ?? "plain";
    return mode === "hybrid"
        ? extractPDFHybridDocumentFromDocument(pdf, options)
        : extractPDFPlainDocumentFromDocument(pdf);
}

export async function extractFullOCRDocumentFromPDF(
    content: Uint8Array,
    pdf: PDFDocumentLike,
    model: LanguageModelV3,
    deps: Pick<FullOCRDeps, "rasterizeSelectedPages" | "transcribePage"> = {}
): Promise<LoadedGraphDocument> {
    const builder = new PDFDocumentBuilder();
    const pages = pdf.getPages();
    const pageTexts = await extractOCRTextFromPDFPages(content, pages, model, deps);

    for (const page of pages) {
        const text = pageTexts.get(page.index)?.trim();
        if (!text) {
            continue;
        }

        builder.appendPage(page.index, text, sourceChunksForWholePageText(text, page));
    }

    return builder.build();
}

function extractPDFPlainDocumentFromDocument(pdf: PDFDocumentLike): LoadedGraphDocument {
    const builder = new PDFDocumentBuilder();

    for (const page of pdf.getPages()) {
        const pageText = preparePageText(pdf, page);
        const entries = pageText.lines
            .map((line): PageContentEntry | null => {
                const text = getLineText(line);
                if (!text) {
                    return null;
                }

                return {
                    type: "text",
                    text,
                    region: regionForBoundingBox("text", page.index + 1, pageText.width, pageText.height, line.bbox),
                };
            })
            .filter((entry): entry is PageContentEntry => entry !== null);
        const { content, entries: materializedEntries } = materializePageEntries(entries, "\n");
        builder.appendPage(page.index, content, groupTextEntries(materializedEntries));
    }

    return builder.build();
}

async function extractPDFHybridDocumentFromDocument(
    pdf: PDFDocumentLike,
    options: PDFDocumentExtractionOptions
): Promise<LoadedGraphDocument> {
    const pages = preparePages(pdf, Boolean(options.ocrFallback));
    const repeatedEdgePatterns = findRepeatedEdgeLinePatterns(pages.map((entry) => entry.pageText));
    const builder = new PDFDocumentBuilder();
    const ocrFallbackTexts = options.ocrFallback
        ? await extractOCRTextFromPDFPages(
              options.ocrFallback.content,
              pages.filter((entry) => entry.ocrFallback).map((entry) => entry.page),
              options.ocrFallback.model,
              options.ocrFallback
          )
        : new Map<number, string>();
    const renderedPages = pages.map((entry) => {
        if (entry.ocrFallback) {
            return { entry, blocks: [] };
        }

        return {
            entry,
            blocks: renderPageBlocks(
                entry.pageText,
                entry.content.images,
                entry.content.explicitEdges,
                repeatedEdgePatterns,
                options
            ),
        };
    });
    const referencedImages = collectReferencedImages(renderedPages);
    const imageDescriptions =
        referencedImages.length > 0 && options.ocrFallback
            ? await describeOCRImages(referencedImages, options.ocrFallback.model)
            : new Map<string, string>();

    for (const renderedPage of renderedPages) {
        const { entry, blocks } = renderedPage;
        const page = entry.page;

        if (entry.ocrFallback) {
            const ocrText = ocrFallbackTexts.get(page.index)?.trim();
            if (ocrText) {
                builder.appendPage(page.index, ocrText, sourceChunksForWholePageText(ocrText, page));
            }

            continue;
        }

        const { content, entries } = materializePageEntries(
            blocks.flatMap((block) =>
                pageContentEntriesForBlock(block, entry.pageText, entry.content.images, imageDescriptions)
            ),
            "\n\n"
        );
        builder.appendPage(page.index, content, sourceChunksForMaterializedEntries(entries));
    }

    return builder.build();
}

function preparePages(pdf: PDFDocumentLike, allowOCRFallback: boolean): PreparedPage[] {
    const pages: PreparedPage[] = [];
    let imageCounter = 0;

    for (const page of pdf.getPages()) {
        const content = analyzePageContent(pdf, page, () => {
            imageCounter += 1;
            return `img-${imageCounter}`;
        });
        const pageText = preparePageText(pdf, page, content);

        pages.push({
            page,
            pageText,
            content,
            ocrFallback: allowOCRFallback && shouldUsePageOCRFallback(pageText, content),
        });
    }

    return pages;
}

function preparePageText(pdf: PDFDocumentLike, page: PDFPageLike, content?: PageContentAnalysis) {
    const pageContent = content ?? analyzePageContent(pdf, page, () => "ignored-image");
    const extractedText = page.extractText();
    const actualTextApplied = applyActualTextToPageText(extractedText, pageContent.actualTextSpans);
    return tidyPageText(actualTextApplied);
}

function collectReferencedImages(
    pages: Array<{ entry: PreparedPage; blocks: RenderBlock[] }>
): Array<PDFOCRImage & Pick<ImageOccurrence, "bbox" | "pageIndex">> {
    const images: Array<PDFOCRImage & Pick<ImageOccurrence, "bbox" | "pageIndex">> = [];
    const seen = new Set<string>();

    for (const { entry, blocks } of pages) {
        const referencedImageIds = extractReferencedImageIds(blocks.map((block) => block.text).join("\n\n"));
        for (const image of entry.content.images) {
            if (!referencedImageIds.has(image.id) || seen.has(image.id)) {
                continue;
            }

            seen.add(image.id);
            images.push(image);
        }
    }

    return images;
}

function pageContentEntriesForBlock(
    block: RenderBlock,
    pageText: PreparedPage["pageText"],
    images: ImageOccurrence[],
    imageDescriptions: Map<string, string>
): PageContentEntry[] {
    if (block.kind !== "image") {
        return [
            {
                type: "text",
                text: block.text.trim(),
                region: regionForBoundingBox(
                    "text",
                    pageText.pageIndex + 1,
                    pageText.width,
                    pageText.height,
                    block.bbox
                ),
            },
        ];
    }

    const imageId = extractImageFenceId(block.text);
    const image = imageId ? images.find((candidate) => candidate.id === imageId) : undefined;
    if (!image) {
        return [];
    }

    const description = imageDescriptions.get(image.id) ?? "";
    return [
        {
            type: "image",
            text: renderImageTag(image.id, description),
            sourceText: description,
            imageId: image.id,
            region: regionForBoundingBox("image", image.pageIndex + 1, pageText.width, pageText.height, image.bbox),
        },
    ];
}

function materializePageEntries(
    entries: PageContentEntry[],
    separator: string
): { content: string; entries: MaterializedPageContentEntry[] } {
    let content = "";
    const materialized: MaterializedPageContentEntry[] = [];

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

function sourceChunksForMaterializedEntries(entries: MaterializedPageContentEntry[]): LocalSourceChunk[] {
    const chunks: LocalSourceChunk[] = [];
    let pendingTextEntries: MaterializedPageContentEntry[] = [];

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

function sourceChunksForWholePageText(
    text: string,
    page: Pick<PDFPageLike, "index" | "width" | "height">
): LocalSourceChunk[] {
    const chunks: LocalSourceChunk[] = [];
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

function groupTextEntries(entries: MaterializedPageContentEntry[]): LocalSourceChunk[] {
    const chunks: LocalSourceChunk[] = [];
    let group: MaterializedPageContentEntry[] = [];
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

function regionForEntries(kind: SourceChunkRegion["kind"], entries: MaterializedPageContentEntry[]): SourceChunkRegion {
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

function regionForBoundingBox(
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

function extractImageFenceId(text: string): string | null {
    return /:::IMG-([^:]+):::/u.exec(text)?.[1] ?? null;
}

function renderImageTag(id: string, description: string): string {
    return `<image id="${escapeXml(id)}">${escapeXml(description)}</image>`;
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

export function shouldUsePageOCRFallback(pageText: PreparedPage["pageText"], content: PageContentAnalysis): boolean {
    const lines = pageText.lines
        .map((line) => ({
            text: getLineText(line),
            direction: inferLineDirection(line),
        }))
        .filter((line) => line.text.length > 0);
    const lineCount = lines.length;
    const characterCount = lines.reduce((total, line) => total + line.text.length, 0);

    if (lineCount === 0) {
        return imageAreaRatio(pageText, content) >= 0.5;
    }

    const shortLineRatio = lines.filter((line) => line.text.length <= 16).length / lineCount;
    const isolatedTokenRatio =
        lines.filter((line) => !/\s/.test(line.text) && line.text.length <= 24).length / lineCount;
    const verticalLineRatio = lines.filter((line) => line.direction === "vertical").length / lineCount;
    const averageLineLength = characterCount / lineCount;
    const alphaFragmentedText = hasAlphaFragmentedText(lines.map((line) => line.text));
    const lineFragmentedText =
        lineCount >= 20 &&
        characterCount >= 200 &&
        (averageLineLength <= 18 || shortLineRatio >= 0.65 || isolatedTokenRatio >= 0.6);
    const fragmentedText = lineFragmentedText || (characterCount >= 200 && alphaFragmentedText);
    const verticalFragments =
        lineCount >= 12 && verticalLineRatio >= 0.25 && (averageLineLength <= 24 || shortLineRatio >= 0.5);
    const imageDominantPage = content.images.length >= 4 && characterCount < 500 && lineCount < 12;

    return fragmentedText || verticalFragments || imageDominantPage;
}

function hasAlphaFragmentedText(lines: string[]): boolean {
    const text = lines.join(" ");
    const alphaTokens = text.match(/\p{L}+/gu) ?? [];

    if (alphaTokens.length < 80) {
        return false;
    }

    const shortAlphaTokens = alphaTokens.filter((token) => token.length <= 2).length;
    const singleAlphaTokens = alphaTokens.filter((token) => token.length === 1).length;
    const shortAlphaTokenRatio = shortAlphaTokens / alphaTokens.length;
    const singleAlphaTokenRatio = singleAlphaTokens / alphaTokens.length;
    const fragmentedRunCount = [...text.matchAll(/(?:\b\p{L}{1,2}\b\s+){4,}\b\p{L}{1,2}\b/gu)].length;

    return (
        (singleAlphaTokenRatio >= 0.18 && shortAlphaTokenRatio >= 0.45) ||
        (fragmentedRunCount >= 4 && singleAlphaTokenRatio >= 0.12 && shortAlphaTokenRatio >= 0.35)
    );
}

function imageAreaRatio(pageText: PreparedPage["pageText"], content: PageContentAnalysis): number {
    const pageArea = pageText.width * pageText.height;
    if (pageArea <= 0) {
        return 0;
    }

    const imageArea = content.images.reduce((total, image) => total + image.bbox.width * image.bbox.height, 0);
    return imageArea / pageArea;
}

export function extractReferencedImageIds(markdown: string): Set<string> {
    const ids = new Set<string>();
    for (const match of markdown.matchAll(/:::IMG-([^:]+):::/g)) {
        const id = match[1];
        if (id) {
            ids.add(id);
        }
    }

    return ids;
}

export function extractPlainTextFromDocument(pdf: PDFDocumentLike): string {
    return extractPDFPlainDocumentFromDocument(pdf).text;
}
