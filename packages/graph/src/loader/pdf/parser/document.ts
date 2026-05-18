import { Effect } from "effect";
import type { PDFDocumentLike, PDFHybridResult, PDFOCRImage, PDFParserOptions, PreparedPage } from "./types";
import { analyzePageContentEffect } from "./content";
import { findRepeatedEdgeLinePatternsEffect, renderPageMarkdownEffect } from "./render";
import { applyActualTextToPageTextEffect, tidyPageTextEffect } from "./text";

export function extractPDFHybridFromDocument(
    pdf: PDFDocumentLike,
    options: PDFParserOptions = {}
): Effect.Effect<PDFHybridResult, unknown> {
    return Effect.gen(function* () {
        const pages = yield* Effect.try({
            try: () => pdf.getPages(),
            catch: (error) => error,
        });
        const images: PDFOCRImage[] = [];
        const pageMarkdown: string[] = [];
        const preparedPages: PreparedPage[] = [];
        let imageCounter = 0;

        for (const page of pages) {
            const content = yield* analyzePageContentEffect(pdf, page, () => {
                imageCounter += 1;
                return `img-${imageCounter}`;
            });
            const extractedText = yield* Effect.try({
                try: () => page.extractText(),
                catch: (error) => error,
            });
            const actualTextApplied = yield* applyActualTextToPageTextEffect(extractedText, content.actualTextSpans);
            const pageText = yield* tidyPageTextEffect(actualTextApplied);

            preparedPages.push({ pageText, content });
        }

        const repeatedEdgePatterns = yield* findRepeatedEdgeLinePatternsEffect(
            preparedPages.map((entry) => entry.pageText)
        );

        for (const entry of preparedPages) {
            const { pageText, content } = entry;

            const markdown = yield* renderPageMarkdownEffect(
                pageText,
                content.images,
                content.explicitEdges,
                repeatedEdgePatterns,
                options
            );
            const referencedImageIds = yield* extractReferencedImageIdsEffect(markdown);
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
    });
}

export function extractReferencedImageIds(markdown: string): Set<string> {
    return Effect.runSync(extractReferencedImageIdsEffect(markdown));
}

export function extractReferencedImageIdsEffect(markdown: string): Effect.Effect<Set<string>, unknown> {
    return Effect.try({
        try: () => extractReferencedImageIdsSync(markdown),
        catch: (error) => error,
    });
}

function extractReferencedImageIdsSync(markdown: string): Set<string> {
    const ids = new Set<string>();
    for (const match of markdown.matchAll(/:::IMG-([^:]+):::/g)) {
        const id = match[1];
        if (id) {
            ids.add(id);
        }
    }

    return ids;
}

export function extractPlainTextFromDocument(pdf: PDFDocumentLike): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const pages = yield* Effect.try({
            try: () => pdf.getPages(),
            catch: (error) => error,
        });
        const pageTexts: string[] = [];

        for (const page of pages) {
            const content = yield* analyzePageContentEffect(pdf, page, () => "ignored-image");
            const extractedText = yield* Effect.try({
                try: () => page.extractText(),
                catch: (error) => error,
            });
            const actualTextApplied = yield* applyActualTextToPageTextEffect(extractedText, content.actualTextSpans);
            const pageText = yield* tidyPageTextEffect(actualTextApplied);
            const text = pageText.text.trim();
            if (text) {
                pageTexts.push(text);
            }
        }

        return pageTexts.join("\n\n");
    });
}
