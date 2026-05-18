import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlot } from "@kiwi/ai/lock";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";
import { generateText } from "ai";
import { Effect } from "effect";
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
    return Effect.runPromise(extractFullOCRTextFromPDFEffect(content, model, deps));
}

export function extractFullOCRTextFromPDFEffect(
    content: ArrayBuffer,
    model: LanguageModelV3,
    deps: FullOCRDeps = {}
): Effect.Effect<string, unknown> {
    const rasterizePages = deps.rasterizePages
        ? (bytes: Uint8Array) =>
              Effect.tryPromise({
                  try: () => deps.rasterizePages!(bytes),
                  catch: (error) => error,
              })
        : defaultRasterizePagesEffect;
    const transcribePage = deps.transcribePage
        ? (image: Uint8Array, languageModel: LanguageModelV3) =>
              Effect.tryPromise({
                  try: () => deps.transcribePage!(image, languageModel),
                  catch: (error) => error,
              })
        : defaultTranscribePageEffect;

    return Effect.gen(function* () {
        const pageImages = yield* rasterizePages(new Uint8Array(content));
        const pageTexts = yield* Effect.all(
            pageImages.map((pageImage) => Effect.map(transcribePage(pageImage, model), (text) => text.trim())),
            { concurrency: "unbounded" }
        );

        return pageTexts.filter((pageText) => pageText.length > 0).join("\n\n");
    });
}

export async function defaultRasterizePages(content: Uint8Array): Promise<Uint8Array[]> {
    return Effect.runPromise(defaultRasterizePagesEffect(content));
}

export function defaultRasterizePagesEffect(content: Uint8Array): Effect.Effect<Uint8Array[], unknown> {
    return Effect.gen(function* () {
        const scale = yield* resolveRasterScaleEffect(content);
        return yield* Effect.tryPromise({
            try: async () => {
                const document = await pdf(Buffer.from(content), { scale });
                const pageImages: Uint8Array[] = [];

                for await (const image of document) {
                    pageImages.push(image);
                }

                return pageImages;
            },
            catch: (error) => error,
        });
    });
}

export async function resolveRasterScale(content: Uint8Array): Promise<number> {
    return Effect.runPromise(resolveRasterScaleEffect(content));
}

export function resolveRasterScaleEffect(content: Uint8Array): Effect.Effect<number, unknown> {
    return Effect.tryPromise({
        try: async () => {
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
        },
        catch: (error) => error,
    });
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
    return Effect.runPromise(defaultTranscribePageEffect(image, model));
}

export function defaultTranscribePageEffect(image: Uint8Array, model: LanguageModelV3): Effect.Effect<string, unknown> {
    return Effect.tryPromise({
        try: async () => {
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
        },
        catch: (error) => error,
    });
}
