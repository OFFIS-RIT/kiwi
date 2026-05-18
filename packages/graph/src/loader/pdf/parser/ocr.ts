import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlot } from "@kiwi/ai/lock";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";
import { generateText } from "ai";
import { pdf } from "pdf-to-img";
import {
    A4_HEIGHT_POINTS,
    A4_OVERSIZE_TOLERANCE,
    A4_WIDTH_POINTS,
    DEFAULT_RASTER_SCALE,
    PNG_MIME_TYPE,
} from "./constants";
import type { FullOCRDeps, PDFDocumentLike, PDFPageLike } from "./types";

export async function extractFullOCRTextFromPDF(
    content: ArrayBuffer,
    model: LanguageModelV3,
    deps: FullOCRDeps = {}
): Promise<string> {
    const rasterizePages = deps.rasterizePages ?? defaultRasterizePages;
    const transcribePage = deps.transcribePage ?? defaultTranscribePage;
    const pageImages = await rasterizePages(new Uint8Array(content));
    const pageTexts = await Promise.all(
        pageImages.map(async (pageImage) => (await transcribePage(pageImage, model)).trim())
    );

    return pageTexts.filter((pageText) => pageText.length > 0).join("\n\n");
}

export async function defaultRasterizePages(content: Uint8Array): Promise<Uint8Array[]> {
    const scale = await resolveRasterScale(content);
    const document = await pdf(Buffer.from(content), { scale });
    const pageImages: Uint8Array[] = [];

    for await (const image of document) {
        pageImages.push(image);
    }

    return pageImages;
}

export async function resolveRasterScale(content: Uint8Array): Promise<number> {
    try {
        const document = await PDF.load(content);
        const pageScales = (document as unknown as PDFDocumentLike)
            .getPages()
            .map(getPageRasterScale)
            .filter((scale) => Number.isFinite(scale) && scale > 0);

        return Math.min(DEFAULT_RASTER_SCALE, ...pageScales);
    } catch {
        return DEFAULT_RASTER_SCALE;
    }
}

export function getPageRasterScale(page: Pick<PDFPageLike, "width" | "height">): number {
    const pageShortEdge = Math.min(page.width, page.height);
    const pageLongEdge = Math.max(page.width, page.height);
    const a4ShortEdge = Math.min(A4_WIDTH_POINTS, A4_HEIGHT_POINTS);
    const a4LongEdge = Math.max(A4_WIDTH_POINTS, A4_HEIGHT_POINTS);

    if (pageShortEdge <= a4ShortEdge * A4_OVERSIZE_TOLERANCE && pageLongEdge <= a4LongEdge * A4_OVERSIZE_TOLERANCE) {
        return DEFAULT_RASTER_SCALE;
    }

    return Math.min(DEFAULT_RASTER_SCALE, a4ShortEdge / pageShortEdge, a4LongEdge / pageLongEdge);
}

export async function defaultTranscribePage(image: Uint8Array, model: LanguageModelV3): Promise<string> {
    const base64 = Buffer.from(image).toString("base64");
    const { text } = await withAiSlot("image", () =>
        generateText({
            model,
            system: transcribePrompt,
            temperature: 0.1,
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
