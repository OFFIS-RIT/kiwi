import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PDF } from "@libpdf/core";
import { PDF_PREVIEW_SCALE } from "@kiwi/files";
import type { PDFDocumentLike, PDFPageLike } from "@kiwi/loaders/loader/pdf/types";
import { rasterizeSelectedPDFPages } from "@kiwi/loaders/loader/pdf/rasterize";

export type PDFPagePreviewOptions = {
    scale?: number;
    maxDimensionPixels?: number;
};

type PDFPagePreviewDeps = {
    loadPDF?: (content: Uint8Array) => Promise<PDFDocumentLike>;
    rasterizeSelectedPages?: typeof rasterizeSelectedPDFPages;
};

const DEFAULT_MAX_DIMENSION_PIXELS = 2400;

export class PDFPagePreviewError extends Schema.TaggedErrorClass<PDFPagePreviewError>()("PDFPagePreviewError", {
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

export const renderPDFPagePreviews: (
    content: Uint8Array,
    pageNumbers: number[],
    options?: PDFPagePreviewOptions,
    deps?: PDFPagePreviewDeps
) => Effect.Effect<Map<number, Uint8Array>, PDFPagePreviewError> = Effect.fn("renderPDFPagePreviews")(function* (
    content: Uint8Array,
    pageNumbers: number[],
    options: PDFPagePreviewOptions = {},
    deps: PDFPagePreviewDeps = {}
): Effect.fn.Return<Map<number, Uint8Array>, PDFPagePreviewError> {
    if (pageNumbers.length === 0) {
        return new Map();
    }

    const loadPDF =
        deps.loadPDF ?? (async (input: Uint8Array) => (await PDF.load(input)) as unknown as PDFDocumentLike);
    const rasterizePages = deps.rasterizeSelectedPages ?? rasterizeSelectedPDFPages;
    const document = yield* Effect.tryPromise({
        try: () => loadPDF(content),
        catch: (cause) => new PDFPagePreviewError({ message: "Failed to load PDF for page previews.", cause }),
    });
    const pages = document.getPages();
    const selectedPages = yield* selectPreviewPages(pages, pageNumbers);
    if (selectedPages.length === 0) {
        return new Map();
    }

    const scale = yield* getPreviewScale(selectedPages, options);
    const renderedByIndex = yield* Effect.tryPromise({
        try: () => rasterizePages(content, selectedPages, scale),
        catch: (cause) => new PDFPagePreviewError({ message: "Failed to rasterize PDF page previews.", cause }),
    });
    const renderedByPageNumber = new Map<number, Uint8Array>();

    for (const page of selectedPages) {
        const image = renderedByIndex.get(page.index);
        if (image) {
            renderedByPageNumber.set(page.index + 1, image);
        }
    }

    return renderedByPageNumber;
});

function selectPreviewPages(
    pages: PDFPageLike[],
    pageNumbers: number[]
): Effect.Effect<PDFPageLike[], PDFPagePreviewError> {
    return Effect.gen(function* () {
        const selectedPages: PDFPageLike[] = [];
        const seen = new Set<number>();

        for (const pageNumber of pageNumbers) {
            if (!Number.isInteger(pageNumber) || pageNumber < 1) {
                return yield* new PDFPagePreviewError({
                    message: `Invalid PDF page number ${pageNumber}`,
                    cause: "Invalid page number",
                });
            }
            if (pageNumber > pages.length) {
                continue;
            }
            if (seen.has(pageNumber)) {
                continue;
            }

            seen.add(pageNumber);
            selectedPages.push(pages[pageNumber - 1]!);
        }

        return selectedPages;
    });
}

function getPreviewScale(
    pages: Array<Pick<PDFPageLike, "width" | "height">>,
    options: PDFPagePreviewOptions
): Effect.Effect<number, PDFPagePreviewError> {
    return Effect.gen(function* () {
        const requestedScale = options.scale ?? PDF_PREVIEW_SCALE;
        const maxDimensionPixels = options.maxDimensionPixels ?? DEFAULT_MAX_DIMENSION_PIXELS;

        if (!Number.isFinite(requestedScale) || requestedScale <= 0) {
            return yield* new PDFPagePreviewError({
                message: `Invalid PDF preview scale ${requestedScale}`,
                cause: "Invalid preview scale",
            });
        }
        if (!Number.isFinite(maxDimensionPixels) || maxDimensionPixels <= 0) {
            return yield* new PDFPagePreviewError({
                message: `Invalid PDF preview max dimension ${maxDimensionPixels}`,
                cause: "Invalid preview max dimension",
            });
        }

        const dimensionScales = pages.flatMap((page) => [
            maxDimensionPixels / Math.max(page.width, 1),
            maxDimensionPixels / Math.max(page.height, 1),
        ]);

        return Math.min(requestedScale, ...dimensionScales);
    });
}
