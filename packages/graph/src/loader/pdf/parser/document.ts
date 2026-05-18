import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
    FullOCRDeps,
    PageContentAnalysis,
    PDFDocumentLike,
    PDFHybridResult,
    PDFOCRImage,
    PDFParserOptions,
    PreparedPage,
} from "./types";
import { analyzePageContent } from "./content";
import { extractOCRTextFromPDFPages } from "./ocr";
import { findRepeatedEdgeLinePatterns, renderPageMarkdown } from "./render";
import { applyActualTextToPageText, getLineText, inferLineDirection, tidyPageText } from "./text";

type PDFHybridOCRFallbackOptions = Pick<FullOCRDeps, "rasterizeSelectedPages" | "transcribePage"> & {
    content: Uint8Array;
    model: LanguageModelV3;
};

type PDFHybridExtractionOptions = PDFParserOptions & {
    ocrFallback?: PDFHybridOCRFallbackOptions;
};

export async function extractPDFHybridFromDocument(
    pdf: PDFDocumentLike,
    options: PDFHybridExtractionOptions = {}
): Promise<PDFHybridResult> {
    const pages = pdf.getPages();
    const images: PDFOCRImage[] = [];
    const pageMarkdown: string[] = [];
    const preparedPages: PreparedPage[] = [];
    let imageCounter = 0;

    for (const page of pages) {
        const content = analyzePageContent(pdf, page, () => {
            imageCounter += 1;
            return `img-${imageCounter}`;
        });
        const extractedText = page.extractText();
        const actualTextApplied = applyActualTextToPageText(extractedText, content.actualTextSpans);
        const pageText = tidyPageText(actualTextApplied);

        preparedPages.push({
            page,
            pageText,
            content,
            ocrFallback: Boolean(options.ocrFallback && shouldUsePageOCRFallback(pageText, content)),
        });
    }

    const repeatedEdgePatterns = findRepeatedEdgeLinePatterns(preparedPages.map((entry) => entry.pageText));
    const ocrFallbackTexts = options.ocrFallback
        ? await extractOCRTextFromPDFPages(
              options.ocrFallback.content,
              preparedPages.filter((entry) => entry.ocrFallback).map((entry) => entry.page),
              options.ocrFallback.model,
              options.ocrFallback
          )
        : new Map<number, string>();

    for (const entry of preparedPages) {
        const { page, pageText, content } = entry;

        if (entry.ocrFallback) {
            const ocrText = ocrFallbackTexts.get(page.index)?.trim();
            if (ocrText) {
                pageMarkdown.push(ocrText);
            }

            continue;
        }

        const markdown = renderPageMarkdown(
            pageText,
            content.images,
            content.explicitEdges,
            repeatedEdgePatterns,
            options
        );
        const referencedImageIds = extractReferencedImageIds(markdown);
        for (const image of content.images) {
            if (!referencedImageIds.has(image.id)) {
                continue;
            }

            images.push({ id: image.id, type: image.type, content: image.content });
        }

        if (markdown.trim().length > 0) {
            pageMarkdown.push(markdown.trim());
        }
    }

    return {
        text: pageMarkdown.join("\n\n"),
        images,
    };
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
    const isolatedTokenRatio = lines.filter((line) => !/\s/.test(line.text) && line.text.length <= 24).length / lineCount;
    const verticalLineRatio = lines.filter((line) => line.direction === "vertical").length / lineCount;
    const averageLineLength = characterCount / lineCount;
    const fragmentedText =
        lineCount >= 20 &&
        characterCount >= 200 &&
        (averageLineLength <= 18 || shortLineRatio >= 0.65 || isolatedTokenRatio >= 0.6);
    const verticalFragments = lineCount >= 12 && verticalLineRatio >= 0.25 && (averageLineLength <= 24 || shortLineRatio >= 0.5);
    const imageDominantPage = content.images.length >= 4 && characterCount < 500 && lineCount < 12;

    return fragmentedText || verticalFragments || imageDominantPage;
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
    const pages = pdf.getPages();
    const pageTexts: string[] = [];

    for (const page of pages) {
        const content = analyzePageContent(pdf, page, () => "ignored-image");
        const extractedText = page.extractText();
        const actualTextApplied = applyActualTextToPageText(extractedText, content.actualTextSpans);
        const pageText = tidyPageText(actualTextApplied);
        const text = pageText.text.trim();
        if (text) {
            pageTexts.push(text);
        }
    }

    return pageTexts.join("\n\n");
}
