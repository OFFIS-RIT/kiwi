import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlot } from "@kiwi/ai/lock";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";
import { generateText } from "ai";
import { DEFAULT_RASTER_SCALE, PNG_MIME_TYPE } from "./constants";
import { rasterizeAllPDFPages, rasterizeSelectedPDFPages } from "./rasterize";
import { rotatePNG } from "./png";
import { renderPageFence } from "../../lib/page-fence";
import type { FullOCRDeps, PDFDocumentLike, PDFOCRPageSelection, PDFPageLike } from "./types";
const MAX_RASTER_DIMENSION_PIXELS = 2000;

export async function extractFullOCRTextFromPDF(
    content: ArrayBuffer,
    model: LanguageModelV3,
    deps: FullOCRDeps = {}
): Promise<string> {
    const rasterizePages = deps.rasterizePages ?? defaultRasterizePages;
    const transcribePage = deps.transcribePage ?? defaultTranscribePage;
    const pageImages = await rasterizePages(new Uint8Array(content));
    const pageTexts = await Promise.all(
        pageImages.map(async (pageImage, index) => {
            const pageText = (await transcribePage(pageImage, model)).trim();
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
    const pageImages = await rasterizeSelectedPages(content, pages);
    const pageTexts = await Promise.all(
        pages.map(async (page) => {
            const image = pageImages.get(page.index);
            if (!image) {
                return undefined;
            }

            const rotatedImage = page.ocrRotation ? rotatePNG(image, page.ocrRotation) : image;
            return [page.index, (await transcribePage(rotatedImage, model)).trim()] as const;
        })
    );

    return new Map(
        pageTexts.filter((entry): entry is readonly [number, string] => entry !== undefined && entry[1].length > 0)
    );
}

export async function defaultRasterizeSelectedPages(
    content: Uint8Array,
    pages: PDFOCRPageSelection[]
): Promise<Map<number, Uint8Array>> {
    const scale = Math.min(DEFAULT_RASTER_SCALE, ...pages.map(getPageRasterScale));
    return rasterizeSelectedPDFPages(content, pages, scale);
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

export function getPageRasterScale(page: Pick<PDFPageLike, "width" | "height">): number {
    const shortEdge = Math.min(page.width, page.height);
    const longEdge = Math.max(page.width, page.height);
    const proportional = Math.min(MAX_RASTER_DIMENSION_PIXELS / shortEdge, MAX_RASTER_DIMENSION_PIXELS / longEdge);
    return Math.min(DEFAULT_RASTER_SCALE, proportional);
}

export async function defaultTranscribePage(image: Uint8Array, model: LanguageModelV3): Promise<string> {
    const base64 = Buffer.from(image).toString("base64");
    const { text } = await withAiSlot("image", () =>
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

    return text;
}
