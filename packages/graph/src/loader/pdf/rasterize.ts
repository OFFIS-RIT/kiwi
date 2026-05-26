import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pdf } from "pdf-to-img";
import type { PDFPageLike } from "./types";

const require = createRequire(import.meta.url);
let pdfJSWasmUrl: string | undefined;

export class GhostscriptUnavailableError extends Error {}

type RasterizeSelectedDeps = {
    ghostscript?: typeof rasterizeSelectedPDFPagesWithGhostscript;
    pdfToImg?: typeof rasterizeSelectedPDFPagesWithPDFToImg;
};

export async function rasterizeAllPDFPages(content: Uint8Array, scale: number): Promise<Uint8Array[]> {
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

export async function rasterizeSelectedPDFPages(
    content: Uint8Array,
    pages: Array<Pick<PDFPageLike, "index" | "width" | "height">>,
    scale: number,
    deps: RasterizeSelectedDeps = {}
): Promise<Map<number, Uint8Array>> {
    const renderWithGhostscript = deps.ghostscript ?? rasterizeSelectedPDFPagesWithGhostscript;
    const renderWithPDFToImg = deps.pdfToImg ?? rasterizeSelectedPDFPagesWithPDFToImg;

    try {
        return await renderWithGhostscript(content, pages, scale);
    } catch (error) {
        if (!(error instanceof GhostscriptUnavailableError)) {
            throw error;
        }
    }

    return renderWithPDFToImg(content, pages, scale);
}

export async function rasterizeSelectedPDFPagesWithPDFToImg(
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

export async function rasterizeSelectedPDFPagesWithGhostscript(
    content: Uint8Array,
    pages: Array<Pick<PDFPageLike, "index">>,
    scale: number
): Promise<Map<number, Uint8Array>> {
    const directory = await mkdtemp(join(tmpdir(), "kiwi-pdf-raster-"));

    try {
        const inputPath = join(directory, "input.pdf");
        await writeFile(inputPath, content);

        const pageImages = new Map<number, Uint8Array>();
        const dpi = Math.max(1, Math.round(72 * scale));
        if (pages.length > 0) {
            const firstPage = Math.min(...pages.map((page) => page.index + 1));
            const lastPage = Math.max(...pages.map((page) => page.index + 1));
            const outputPattern = join(directory, "page-%d.png");
            await runGhostscript([
                "-q",
                "-dSAFER",
                "-dBATCH",
                "-dNOPAUSE",
                "-sDEVICE=pngalpha",
                `-r${dpi}`,
                `-dFirstPage=${firstPage}`,
                `-dLastPage=${lastPage}`,
                `-sOutputFile=${outputPattern}`,
                inputPath,
            ]);
            for (const page of pages) {
                const pageNumber = page.index + 1;
                const outputNumber = pageNumber - firstPage + 1;
                const outputPath = join(directory, `page-${outputNumber}.png`);
                pageImages.set(page.index, await readFile(outputPath));
            }
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
