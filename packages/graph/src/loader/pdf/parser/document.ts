import type { PDFDocumentLike, PDFHybridResult, PDFOCRImage, PDFParserOptions, PreparedPage } from "./types";
import { analyzePageContent } from "./content";
import { findRepeatedEdgeLinePatterns, renderPageMarkdown } from "./render";
import { applyActualTextToPageText, tidyPageText } from "./text";

export function extractPDFHybridFromDocument(
    pdf: PDFDocumentLike,
    options: PDFParserOptions = {}
): PDFHybridResult {
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

        preparedPages.push({ pageText, content });
    }

    const repeatedEdgePatterns = findRepeatedEdgeLinePatterns(preparedPages.map((entry) => entry.pageText));

    for (const entry of preparedPages) {
        const { pageText, content } = entry;

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
