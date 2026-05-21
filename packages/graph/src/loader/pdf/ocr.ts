import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlot } from "@kiwi/ai/lock";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";
import { generateText } from "ai";
import { pdf } from "pdf-to-img";
import { DEFAULT_RASTER_SCALE, PNG_MIME_TYPE } from "./constants";
import { renderPageFence } from "../../lib/page-fence";
import type { FullOCRDeps, PDFDocumentLike, PDFPageLike } from "./types";

const require = createRequire(import.meta.url);
const LARGE_PAGE_RASTER_SCALE = 0.75;
const MAX_RASTER_DIMENSION_PIXELS = 2000;
const A4_SHORT_EDGE_POINTS = 595.28;
const A4_LONG_EDGE_POINTS = 841.89;
const LARGE_PAGE_TOLERANCE = 1.1;
let pdfJSWasmUrl: string | undefined;

class GhostscriptUnavailableError extends Error {}

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
    const document = await pdf(Buffer.from(content), {
        scale,
        docInitParams: getPDFJSWasmDocInitParams(),
    });
    const pageImages: Uint8Array[] = [];

    for await (const image of document) {
        pageImages.push(image);
    }

    return pageImages;
}

export async function extractOCRTextFromPDFPages(
    content: Uint8Array,
    pages: Array<Pick<PDFPageLike, "index" | "width" | "height">>,
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

            return [page.index, (await transcribePage(image, model)).trim()] as const;
        })
    );

    return new Map(
        pageTexts.filter((entry): entry is readonly [number, string] => entry !== undefined && entry[1].length > 0)
    );
}

export async function defaultRasterizeSelectedPages(
    content: Uint8Array,
    pages: Array<Pick<PDFPageLike, "index" | "width" | "height">>
): Promise<Map<number, Uint8Array>> {
    const scale = Math.min(DEFAULT_RASTER_SCALE, ...pages.map(getPageRasterScale));

    try {
        return await rasterizeSelectedPagesWithGhostscript(content, pages, scale);
    } catch (error) {
        if (!(error instanceof GhostscriptUnavailableError)) {
            throw error;
        }
    }

    return rasterizeSelectedPagesWithPDFToImg(content, pages, scale);
}

async function rasterizeSelectedPagesWithPDFToImg(
    content: Uint8Array,
    pages: Array<Pick<PDFPageLike, "index" | "width" | "height">>,
    scale: number
): Promise<Map<number, Uint8Array>> {
    const document = await pdf(Buffer.from(content), {
        scale,
        docInitParams: getPDFJSWasmDocInitParams(),
    });
    const pageImages = new Map<number, Uint8Array>();

    for (const page of pages) {
        pageImages.set(page.index, await document.getPage(page.index + 1));
    }

    return pageImages;
}

async function rasterizeSelectedPagesWithGhostscript(
    content: Uint8Array,
    pages: Array<Pick<PDFPageLike, "index">>,
    scale: number
): Promise<Map<number, Uint8Array>> {
    const directory = await mkdtemp(join(tmpdir(), "kiwi-pdf-ocr-"));

    try {
        const inputPath = join(directory, "input.pdf");
        await writeFile(inputPath, content);

        const pageImages = new Map<number, Uint8Array>();
        const dpi = Math.max(1, Math.round(72 * scale));
        for (const page of pages) {
            const pageNumber = page.index + 1;
            const outputPath = join(directory, `page-${pageNumber}.png`);
            await runGhostscript([
                "-q",
                "-dSAFER",
                "-dBATCH",
                "-dNOPAUSE",
                "-sDEVICE=pngalpha",
                `-r${dpi}`,
                `-dFirstPage=${pageNumber}`,
                `-dLastPage=${pageNumber}`,
                `-sOutputFile=${outputPath}`,
                inputPath,
            ]);
            pageImages.set(page.index, await readFile(outputPath));
        }

        return pageImages;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function runGhostscript(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("gs", args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            output += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
            output += chunk;
        });
        child.on("error", (error) => {
            if (isCommandNotFound(error)) {
                reject(new GhostscriptUnavailableError("Ghostscript is not available"));
                return;
            }

            reject(error);
        });
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`Ghostscript failed with exit code ${code}: ${output.trim()}`));
        });
    });
}

function isCommandNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getPDFJSWasmDocInitParams(): { wasmUrl: string } | undefined {
    const wasmUrl = getPDFJSWasmUrl();
    return wasmUrl ? { wasmUrl } : undefined;
}

function getPDFJSWasmUrl(): string | undefined {
    if (pdfJSWasmUrl !== undefined) {
        return pdfJSWasmUrl;
    }

    try {
        const pdfToImgEntry = require.resolve("pdf-to-img");
        const pdfToImgRequire = createRequire(pdfToImgEntry);
        const pdfJSPath = dirname(pdfToImgRequire.resolve("pdfjs-dist/package.json"));
        pdfJSWasmUrl = join(pdfJSPath, "wasm") + "/";
    } catch {
        pdfJSWasmUrl = "";
    }

    return pdfJSWasmUrl || undefined;
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
    const largePage =
        shortEdge > A4_SHORT_EDGE_POINTS * LARGE_PAGE_TOLERANCE ||
        longEdge > A4_LONG_EDGE_POINTS * LARGE_PAGE_TOLERANCE;

    if (!largePage) {
        return DEFAULT_RASTER_SCALE;
    }

    const proportional = Math.min(MAX_RASTER_DIMENSION_PIXELS / shortEdge, MAX_RASTER_DIMENSION_PIXELS / longEdge);
    return Math.min(LARGE_PAGE_RASTER_SCALE, proportional);
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
