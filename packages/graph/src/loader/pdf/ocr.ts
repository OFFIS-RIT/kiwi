import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlot } from "@kiwi/ai/lock";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";
import { generateText } from "ai";
import { DEFAULT_RASTER_SCALE, PNG_MIME_TYPE } from "./constants";
import { rasterizeAllPDFPages, rasterizeSelectedPDFPages } from "./rasterize";
import { rotatePNG } from "./png";
import { renderPageFence } from "../../lib/page-fence";
import type {
    FullOCRDeps,
    PDFDocumentLike,
    PDFOCRPageSelection,
    PDFOCRRotation,
    PDFPageLike,
    PDFPageTranscription,
} from "./types";
const MAX_RASTER_DIMENSION_PIXELS = 3000;
const OCR_RETRY_SCALE_MULTIPLIERS = [1.25, 1.5] as const;
const ROTATED_OCR_RASTER_SCALE = 3;
const ROTATED_OCR_RETRY_SCALES = [2] as const;
const OCR_RETRY_ROTATION: PDFOCRRotation = 90;

export async function extractFullOCRTextFromPDF(
    content: ArrayBuffer,
    model: LanguageModelV3,
    deps: FullOCRDeps = {}
): Promise<string> {
    const contentBytes = new Uint8Array(content);
    if (!deps.rasterizePages) {
        const pdf = (await PDF.load(contentBytes)) as unknown as PDFDocumentLike;
        const pageTexts = await extractOCRTextFromPDFPages(contentBytes, pdf.getPages(), model, deps);
        const fencedPageTexts = pdf.getPages().map((page) => {
            const pageText = pageTexts.get(page.index)?.trim();
            return pageText ? `${renderPageFence(page.index + 1)}\n\n${pageText}` : "";
        });

        return fencedPageTexts.filter((pageText) => pageText.length > 0).join("\n\n");
    }

    const rasterizePages = deps.rasterizePages;
    const transcribePage = deps.transcribePage ?? defaultTranscribePage;
    const pageImages = await rasterizePages(contentBytes);
    const pageTexts = await Promise.all(
        pageImages.map(async (pageImage, index) => {
            const transcription = normalizePageTranscription(await transcribePage(pageImage, model));
            if (transcription.finishReason === "length") {
                return "";
            }

            const pageText = transcription.text.trim();
            return pageText ? `${renderPageFence(index + 1)}\n\n${pageText}` : "";
        })
    );

    return pageTexts.filter((pageText) => pageText.length > 0).join("\n\n");
}

export async function defaultRasterizePages(content: Uint8Array): Promise<Uint8Array[]> {
    const scale = await resolveRasterScale(content);
    return rasterizeAllPDFPages(content, scale);
}

export async function extractOCRTextFromPDFPages(
    content: Uint8Array,
    pages: PDFOCRPageSelection[],
    model: LanguageModelV3,
    deps: Pick<FullOCRDeps, "rasterizeSelectedPages" | "transcribePage"> = {}
): Promise<Map<number, string>> {
    if (pages.length === 0) {
        return new Map();
    }

    const rasterizeSelectedPages = deps.rasterizeSelectedPages ?? defaultRasterizeSelectedPages;
    const transcribePage = deps.transcribePage ?? defaultTranscribePage;
    const pageImages = await rasterizeInitialOCRPages(content, pages, rasterizeSelectedPages);
    const pageTexts = await Promise.all(
        pages.map(async (page) => {
            const image = pageImages.get(page.index);
            if (!image) {
                return undefined;
            }

            return transcribeOCRPageWithRetries({
                content,
                page,
                image,
                model,
                rasterizeSelectedPages,
                transcribePage,
            });
        })
    );

    return new Map(
        pageTexts.filter((entry): entry is readonly [number, string] => entry !== undefined && entry[1].length > 0)
    );
}

async function rasterizeInitialOCRPages(
    content: Uint8Array,
    pages: PDFOCRPageSelection[],
    rasterizeSelectedPages: NonNullable<FullOCRDeps["rasterizeSelectedPages"]>
): Promise<Map<number, Uint8Array>> {
    const groupedPages = new Map<number | undefined, PDFOCRPageSelection[]>();
    for (const page of pages) {
        const scale = getInitialOCRRasterScale(page);
        const rasterScale = scale === DEFAULT_RASTER_SCALE ? undefined : scale;
        groupedPages.set(rasterScale, [...(groupedPages.get(rasterScale) ?? []), page]);
    }

    const pageImages = new Map<number, Uint8Array>();
    await Promise.all(
        [...groupedPages.entries()].map(async ([scale, scalePages]) => {
            const images = await rasterizeSelectedPages(content, scalePages, scale);
            for (const [pageIndex, image] of images) {
                pageImages.set(pageIndex, image);
            }
        })
    );

    return pageImages;
}

function getInitialOCRRasterScale(page: PDFOCRPageSelection): number {
    return hasOCRRotation(page) ? ROTATED_OCR_RASTER_SCALE : DEFAULT_RASTER_SCALE;
}

function getRetryOCRRasterScales(page: PDFOCRPageSelection): number[] {
    if (hasOCRRotation(page)) {
        return [...ROTATED_OCR_RETRY_SCALES];
    }

    return OCR_RETRY_SCALE_MULTIPLIERS.map((multiplier) => getPageRasterScale(page, DEFAULT_RASTER_SCALE * multiplier));
}

function hasOCRRotation(page: PDFOCRPageSelection): boolean {
    return page.ocrRotation !== undefined && page.ocrRotation !== 0;
}

export async function defaultRasterizeSelectedPages(
    content: Uint8Array,
    pages: PDFOCRPageSelection[],
    scale?: number
): Promise<Map<number, Uint8Array>> {
    const desiredScale = scale ?? DEFAULT_RASTER_SCALE;
    const resolvedScale = Math.min(desiredScale, ...pages.map((page) => getPageRasterScale(page, desiredScale)));
    return rasterizeSelectedPDFPages(content, pages, resolvedScale);
}

async function transcribeOCRPageWithRetries(options: {
    content: Uint8Array;
    page: PDFOCRPageSelection;
    image: Uint8Array;
    model: LanguageModelV3;
    rasterizeSelectedPages: NonNullable<FullOCRDeps["rasterizeSelectedPages"]>;
    transcribePage: NonNullable<FullOCRDeps["transcribePage"]>;
}): Promise<readonly [number, string] | undefined> {
    let retryImage = options.image;
    const initialTranscription = await transcribePageImage(
        options.image,
        options.page.ocrRotation,
        options.model,
        options.transcribePage
    );
    if (initialTranscription.finishReason !== "length") {
        return [options.page.index, initialTranscription.text.trim()];
    }

    for (const retryScale of getRetryOCRRasterScales(options.page)) {
        const pageImages = await options.rasterizeSelectedPages(options.content, [options.page], retryScale);
        const pageImage = pageImages.get(options.page.index);
        if (!pageImage) {
            return undefined;
        }

        retryImage = pageImage;
        const transcription = await transcribePageImage(
            pageImage,
            options.page.ocrRotation,
            options.model,
            options.transcribePage
        );
        if (transcription.finishReason !== "length") {
            return [options.page.index, transcription.text.trim()];
        }
    }

    const rotatedTranscription = await transcribePageImage(
        retryImage,
        addOCRRotation(options.page.ocrRotation, OCR_RETRY_ROTATION),
        options.model,
        options.transcribePage
    );
    if (rotatedTranscription.finishReason !== "length") {
        return [options.page.index, rotatedTranscription.text.trim()];
    }

    return undefined;
}

async function transcribePageImage(
    image: Uint8Array,
    rotation: PDFOCRRotation | undefined,
    model: LanguageModelV3,
    transcribePage: NonNullable<FullOCRDeps["transcribePage"]>
): Promise<PDFPageTranscription> {
    const pageImage = rotation ? rotatePNG(image, rotation) : image;
    return normalizePageTranscription(await transcribePage(pageImage, model));
}

function addOCRRotation(rotation: PDFOCRRotation | undefined, degrees: PDFOCRRotation): PDFOCRRotation {
    return (((rotation ?? 0) + degrees) % 360) as PDFOCRRotation;
}

function normalizePageTranscription(transcription: string | PDFPageTranscription): PDFPageTranscription {
    return typeof transcription === "string" ? { text: transcription } : transcription;
}

export async function resolveRasterScale(content: Uint8Array): Promise<number> {
    try {
        const document = await PDF.load(content);
        const pageScales = (document as unknown as PDFDocumentLike).getPages().map(getPageRasterScale);

        return Math.min(DEFAULT_RASTER_SCALE, ...pageScales);
    } catch {
        return DEFAULT_RASTER_SCALE;
    }
}

export function getPageRasterScale(
    page: Pick<PDFPageLike, "width" | "height">,
    desiredScale = DEFAULT_RASTER_SCALE
): number {
    const longEdge = Math.max(page.width, page.height);
    if (longEdge <= 0) {
        return Math.min(desiredScale, DEFAULT_RASTER_SCALE);
    }

    return Math.min(desiredScale, MAX_RASTER_DIMENSION_PIXELS / longEdge);
}

export async function defaultTranscribePage(image: Uint8Array, model: LanguageModelV3): Promise<PDFPageTranscription> {
    const base64 = Buffer.from(image).toString("base64");
    const { text, finishReason } = await withAiSlot("image", () =>
        generateText({
            model,
            system: transcribePrompt,
            temperature: 0,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            image: `data:${PNG_MIME_TYPE};base64,${base64}`,
                        },
                    ],
                },
            ],
        })
    );

    return { text, finishReason };
}
