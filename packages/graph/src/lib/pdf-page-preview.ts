import { PDF } from "@libpdf/core";
import { PDF_PREVIEW_SCALE } from "@kiwi/files";
import type { PDFDocumentLike, PDFPageLike } from "../loader/pdf/types";
import { rasterizeSelectedPDFPages } from "../loader/pdf/rasterize";

export type PDFPagePreviewOptions = {
    scale?: number;
    maxDimensionPixels?: number;
};

type PDFPagePreviewDeps = {
    loadPDF?: (content: Uint8Array) => Promise<PDFDocumentLike>;
    rasterizeSelectedPages?: typeof rasterizeSelectedPDFPages;
};

const DEFAULT_MAX_DIMENSION_PIXELS = 2400;

export async function renderPDFPagePreviews(
    content: Uint8Array,
    pageNumbers: number[],
    options: PDFPagePreviewOptions = {},
    deps: PDFPagePreviewDeps = {}
): Promise<Map<number, Uint8Array>> {
    if (pageNumbers.length === 0) {
        return new Map();
    }

    const loadPDF =
        deps.loadPDF ?? (async (input: Uint8Array) => (await PDF.load(input)) as unknown as PDFDocumentLike);
    const rasterizePages = deps.rasterizeSelectedPages ?? rasterizeSelectedPDFPages;
    const document = await loadPDF(content);
    const pages = document.getPages();
    const selectedPages = selectPreviewPages(pages, pageNumbers);
    if (selectedPages.length === 0) {
        return new Map();
    }

    const scale = getPreviewScale(selectedPages, options);
    const renderedByIndex = await rasterizePages(content, selectedPages, scale);
    const renderedByPageNumber = new Map<number, Uint8Array>();

    for (const page of selectedPages) {
        const image = renderedByIndex.get(page.index);
        if (image) {
            renderedByPageNumber.set(page.index + 1, image);
        }
    }

    return renderedByPageNumber;
}

function selectPreviewPages(pages: PDFPageLike[], pageNumbers: number[]): PDFPageLike[] {
    const selectedPages: PDFPageLike[] = [];
    const seen = new Set<number>();

    for (const pageNumber of pageNumbers) {
        if (!Number.isInteger(pageNumber) || pageNumber < 1) {
            throw new Error(`Invalid PDF page number ${pageNumber}`);
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
}

function getPreviewScale(pages: Array<Pick<PDFPageLike, "width" | "height">>, options: PDFPagePreviewOptions): number {
    const requestedScale = options.scale ?? PDF_PREVIEW_SCALE;
    const maxDimensionPixels = options.maxDimensionPixels ?? DEFAULT_MAX_DIMENSION_PIXELS;

    if (!Number.isFinite(requestedScale) || requestedScale <= 0) {
        throw new Error(`Invalid PDF preview scale ${requestedScale}`);
    }
    if (!Number.isFinite(maxDimensionPixels) || maxDimensionPixels <= 0) {
        throw new Error(`Invalid PDF preview max dimension ${maxDimensionPixels}`);
    }

    const dimensionScales = pages.flatMap((page) => [
        maxDimensionPixels / Math.max(page.width, 1),
        maxDimensionPixels / Math.max(page.height, 1),
    ]);

    return Math.min(requestedScale, ...dimensionScales);
}
