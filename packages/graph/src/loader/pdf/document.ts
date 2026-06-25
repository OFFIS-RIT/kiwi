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
    PDFParserOptions,
    PDFPageLike,
    PreparedPage,
    RenderBlock,
} from "./types";
import { analyzePageContent } from "./content";
import { extractOCRTextFromPDFPages } from "./ocr";
import { getPDFPageGeometry, type PDFPageGeometry } from "./page-geometry";
import { findRepeatedEdgeLinePatterns, renderPageBlocks } from "./render";
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
        });
    }

    return pages;
}

function preparePageText(pdf: PDFDocumentLike, page: PDFPageLike, content?: PageContentAnalysis) {
    const pageContent = content ?? analyzePageContent(pdf, page, () => "ignored-image");
    const extractedText = repairPageTextLoneSurrogates(page.extractText());
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
