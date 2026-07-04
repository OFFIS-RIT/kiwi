import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { LoadedGraphDocument } from "../..";
import { describeOCRImages } from "../../lib/ocr-image";
import { stripPageFences } from "../../lib/page-fence";
import type {
    FullOCRDeps,
    ImageOccurrence,
    PageContentAnalysis,
    PDFDocumentLike,
    PDFOCRImage,
    PDFOCRRotation,
    PDFParserOptions,
    PDFPageLike,
    PreparedPage,
    RenderBlock,
} from "./types";
import { analyzePageContent } from "./content";
import { extractOCRTextFromPDFPages } from "./ocr";
import { getPDFPageGeometry, type PDFPageGeometry } from "./page-geometry";
import { findRepeatedEdgeLinePatterns, renderPageBlocks } from "./render";
import { detectTables, extractWords, looksLikeDenseDrawnGridLayout, looksLikeRotatedDrawnTableLayout } from "./table";
import {
    extractImageFenceId,
    materializePageEntries,
    PDFDocumentBuilder,
    regionForBoundingBox,
    renderImageTag,
    sourceChunksForMaterializedEntries,
    sourceChunksForWholePageText,
    type PDFPageContentEntry as PageContentEntry,
} from "./source-reference";
import { applyActualTextToPageText, getLineText, inferLineDirection, tidyPageText } from "./text";
import { repairPageTextLoneSurrogates } from "./unicode";

const IMAGE_ONLY_OCR_RASTER_SCALE = 1;

type PDFHybridOCRFallbackOptions = Pick<FullOCRDeps, "rasterizeSelectedPages" | "transcribePage"> & {
    content: Uint8Array;
    model: LanguageModelV3;
};

type PDFDocumentExtractionOptions = PDFParserOptions & {
    mode?: "plain" | "hybrid";
    ocrFallback?: PDFHybridOCRFallbackOptions;
};

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

        builder.appendPage(page.index, text, sourceChunksForWholePageText(text, getPDFPageGeometry(pdf, page)));
    }

    return builder.build();
}

function extractPDFPlainDocumentFromDocument(pdf: PDFDocumentLike): LoadedGraphDocument {
    const builder = new PDFDocumentBuilder();

    for (const page of pdf.getPages()) {
        const pageText = preparePageText(pdf, page);
        const geometry = getPDFPageGeometry(pdf, page);
        const entries = pageText.lines
            .map((line): PageContentEntry | null => {
                const text = getLineText(line);
                if (!text) {
                    return null;
                }

                const region = regionForBoundingBox("text", geometry, line.bbox);
                if (!region) {
                    return null;
                }

                return {
                    type: "text",
                    text,
                    region,
                };
            })
            .filter((entry): entry is PageContentEntry => entry !== null);
        const { content, entries: materializedEntries } = materializePageEntries(entries, "\n");
        builder.appendPage(page.index, content, sourceChunksForMaterializedEntries(materializedEntries));
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
              pages
                  .filter((entry) => entry.ocrFallback)
                  .map((entry) => ({
                      index: entry.page.index,
                      width: entry.page.width,
                      height: entry.page.height,
                      ocrRotation: entry.ocrRotation,
                      ocrRasterScale: getInitialOCRFallbackRasterScale(entry),
                  })),
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
    const referencedImages = collectReferencedImages(pdf, renderedPages);
    const imageDescriptions =
        referencedImages.length > 0 && options.ocrFallback
            ? await describeOCRImages(referencedImages, options.ocrFallback.model)
            : new Map<string, string>();

    for (const renderedPage of renderedPages) {
        const { entry, blocks } = renderedPage;
        const page = entry.page;
        const geometry = getPDFPageGeometry(pdf, page);

        if (entry.ocrFallback) {
            const ocrText = ocrFallbackTexts.get(page.index)?.trim();
            if (ocrText) {
                builder.appendPage(page.index, ocrText, sourceChunksForWholePageText(ocrText, geometry));
            }

            continue;
        }

        const { content, entries } = materializePageEntries(
            blocks.flatMap((block) =>
                pageContentEntriesForBlock(block, geometry, entry.content.images, imageDescriptions)
            ),
            "\n\n"
        );
        builder.appendPage(page.index, content, sourceChunksForMaterializedEntries(entries));
    }

    const document = builder.build();
    if (stripPageFences(document.text).trim() === "" && options.ocrFallback) {
        return extractFullOCRDocumentFromPDF(
            options.ocrFallback.content,
            pdf,
            options.ocrFallback.model,
            options.ocrFallback
        );
    }

    return document;
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
            ocrRotation: getPageOCRRotation(pageText, content),
        });
    }

    return pages;
}

function getInitialOCRFallbackRasterScale(entry: PreparedPage): number | undefined {
    if (entry.ocrRotation !== 0) {
        return undefined;
    }

    const textLines = entry.pageText.lines.map(getLineText).filter((line) => line.length > 0);
    const characterCount = textLines.reduce((total, line) => total + line.length, 0);
    if (textLines.length <= 2 && characterCount < 80 && imageAreaRatio(entry.pageText, entry.content) >= 0.5) {
        return IMAGE_ONLY_OCR_RASTER_SCALE;
    }

    return undefined;
}

function preparePageText(pdf: PDFDocumentLike, page: PDFPageLike, content?: PageContentAnalysis) {
    const pageContent = content ?? analyzePageContent(pdf, page, () => "ignored-image");
    const extractedText = repairPageTextLoneSurrogates(page.extractText());
    const actualTextApplied = applyActualTextToPageText(extractedText, pageContent.actualTextSpans);
    return tidyPageText(actualTextApplied);
}

function collectReferencedImages(
    pdf: PDFDocumentLike,
    pages: Array<{ entry: PreparedPage; blocks: RenderBlock[] }>
): Array<PDFOCRImage & Pick<ImageOccurrence, "bbox" | "pageIndex">> {
    const images: Array<PDFOCRImage & Pick<ImageOccurrence, "bbox" | "pageIndex">> = [];
    const seen = new Set<string>();

    for (const { entry, blocks } of pages) {
        const geometry = getPDFPageGeometry(pdf, entry.page);
        const referencedImageIds = extractReferencedImageIds(blocks.map((block) => block.text).join("\n\n"));
        for (const image of entry.content.images) {
            if (!referencedImageIds.has(image.id) || seen.has(image.id) || !regionForBoundingBox("image", geometry, image.bbox)) {
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
    geometry: PDFPageGeometry,
    images: ImageOccurrence[],
    imageDescriptions: Map<string, string>
): PageContentEntry[] {
    if (block.kind !== "image") {
        const region = regionForBoundingBox("text", geometry, block.bbox);
        if (!region) {
            return [];
        }

        return [
            {
                type: "text",
                text: block.text.trim(),
                region,
            },
        ];
    }

    const imageId = extractImageFenceId(block.text);
    const image = imageId ? images.find((candidate) => candidate.id === imageId) : undefined;
    if (!image) {
        return [];
    }

    const description = imageDescriptions.get(image.id) ?? "";
    const region = regionForBoundingBox("image", geometry, image.bbox);
    if (!region) {
        return [];
    }

    return [
        {
            type: "image",
            text: renderImageTag(image.id, description),
            sourceText: description,
            imageId: image.id,
            region,
        },
    ];
}

export function getPageOCRRotation(pageText: PreparedPage["pageText"], content: PageContentAnalysis): PDFOCRRotation {
    const rotatedDrawnTable = getRotatedDrawnTableSignal(pageText, content);
    return rotatedDrawnTable.hasLargeDetectedTable || rotatedDrawnTable.hasHighConfidenceGrid ? 90 : 0;
}

function getRotatedDrawnTableSignal(
    pageText: PreparedPage["pageText"],
    content: PageContentAnalysis
): { hasLargeDetectedTable: boolean; hasHighConfidenceGrid: boolean } {
    const textLines = pageText.lines.filter((line) => getLineText(line).length > 0);
    if (textLines.length < 12) {
        return { hasLargeDetectedTable: false, hasHighConfidenceGrid: false };
    }

    const verticalLineRatio =
        textLines.filter((line) => inferLineDirection(line) === "vertical").length / textLines.length;
    if (verticalLineRatio < 0.85) {
        return { hasLargeDetectedTable: false, hasHighConfidenceGrid: false };
    }

    const nonStrictDrawnEdges = content.explicitEdges.filter(
        (edge) => edge.source === "rect" || edge.source === "curve"
    );
    const verticalEdgeCount = nonStrictDrawnEdges.filter((edge) => edge.orientation === "vertical").length;
    const horizontalEdgeCount = nonStrictDrawnEdges.filter((edge) => edge.orientation === "horizontal").length;
    if (
        verticalEdgeCount < 3 ||
        horizontalEdgeCount < 4 ||
        !looksLikeRotatedDrawnTableLayout(pageText.lines, nonStrictDrawnEdges)
    ) {
        return { hasLargeDetectedTable: false, hasHighConfidenceGrid: false };
    }

    const tables = detectTables(
        pageText,
        extractWords(pageText),
        pageText.lines,
        content.explicitEdges,
        "lines_strict"
    );
    const pageArea = pageText.width * pageText.height;
    const hasLargeDetectedTable =
        pageArea > 0 &&
        tables.some(
            (table) =>
                table.rowCount >= 4 &&
                table.colCount >= 2 &&
                table.cells.length >= 8 &&
                (table.bbox.width * table.bbox.height) / pageArea >= 0.12
        );

    return {
        hasLargeDetectedTable,
        hasHighConfidenceGrid: hasHighConfidenceRotatedDrawnGrid(pageText, nonStrictDrawnEdges),
    };
}

function hasHighConfidenceRotatedDrawnGrid(
    pageText: PreparedPage["pageText"],
    edges: PageContentAnalysis["explicitEdges"]
): boolean {
    const bounds = drawnEdgeBounds(edges);
    if (!bounds) {
        return false;
    }

    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    return (
        width / pageText.width >= 0.12 &&
        height / pageText.height >= 0.5 &&
        (width * height) / (pageText.width * pageText.height) >= 0.12
    );
}

function drawnEdgeBounds(
    edges: PageContentAnalysis["explicitEdges"]
): { left: number; right: number; top: number; bottom: number } | null {
    if (edges.length === 0) {
        return null;
    }

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const edge of edges) {
        if (edge.orientation === "vertical") {
            left = Math.min(left, edge.position);
            right = Math.max(right, edge.position);
            top = Math.min(top, edge.start, edge.end);
            bottom = Math.max(bottom, edge.start, edge.end);
            continue;
        }

        left = Math.min(left, edge.start, edge.end);
        right = Math.max(right, edge.start, edge.end);
        top = Math.min(top, edge.position);
        bottom = Math.max(bottom, edge.position);
    }

    if (![left, right, top, bottom].every(Number.isFinite)) {
        return null;
    }

    return { left, right, top, bottom };
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
    if (getRotatedDrawnTableSignal(pageText, content).hasLargeDetectedTable) {
        return false;
    }
    if (looksLikeDenseDrawnGridLayout(pageText, pageText.lines, content.explicitEdges)) {
        return false;
    }
    if (hasSubstantialDrawnTableText(content, lineCount, characterCount)) {
        return false;
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
    const imageDominantPage = content.images.length >= 4 && characterCount < 80 && lineCount <= 2;

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

function hasSubstantialDrawnTableText(
    content: PageContentAnalysis,
    lineCount: number,
    characterCount: number
): boolean {
    if (lineCount < 10 || characterCount < 200) {
        return false;
    }

    const drawnEdges = content.explicitEdges.filter((edge) => edge.source !== "text");
    const horizontalEdgeCount = drawnEdges.filter((edge) => edge.orientation === "horizontal").length;
    const verticalEdgeCount = drawnEdges.filter((edge) => edge.orientation === "vertical").length;

    return horizontalEdgeCount >= 8 && verticalEdgeCount >= 4;
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
