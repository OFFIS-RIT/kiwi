import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Effect } from "effect";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { processOCRImages } from "../lib/ocr-image";
import { extractPDFHybridFromDocument, extractPlainTextFromDocument } from "./pdf/parser/document";
import { extractFullOCRTextFromPDF, extractFullOCRTextFromPDFEffect } from "./pdf/parser/ocr";
import type { PDFDocumentLike, PDFTableMode } from "./pdf/parser/types";

export { extractFullOCRTextFromPDF } from "./pdf/parser/ocr";
export type PDFMode = "plain" | "hybrid" | "ocr";
export type { PDFTableMode } from "./pdf/parser/types";

export class PDFLoader implements GraphLoader {
    readonly filetype = "pdf";
    private cachedModeText?: Promise<string>;

    constructor(
        private options: {
            loader: GraphBinaryLoader;
            mode?: PDFMode;
            tableMode?: PDFTableMode;
            model?: LanguageModelV3;
            storage?: { bucket: string; imagePrefix: string };
        }
    ) {}

    async getText(): Promise<string> {
        const mode = this.options.mode ?? "plain";

        if (mode !== "plain") {
            this.cachedModeText ??= this.getModeText(mode);
            return this.cachedModeText;
        }

        return Effect.runPromise(this.getPlainTextEffect());
    }

    private async getModeText(mode: Exclude<PDFMode, "plain">): Promise<string> {
        return Effect.runPromise(mode === "hybrid" ? this.getHybridTextEffect() : this.getFullOCRTextEffect());
    }

    private getPlainTextEffect(): Effect.Effect<string, unknown> {
        return Effect.gen(this, function* () {
            const pdf = yield* this.loadPDFEffect();
            return yield* extractPlainTextFromDocument(pdf);
        });
    }

    private getHybridTextEffect(): Effect.Effect<string, unknown> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            return Effect.fail(new Error("PDF hybrid mode requires an image model and storage configuration"));
        }

        return Effect.gen(this, function* () {
            const pdf = yield* this.loadPDFEffect();
            const result = yield* extractPDFHybridFromDocument(pdf, {
                tableMode: this.options.tableMode,
            });
            return yield* Effect.tryPromise({
                try: () => processOCRImages(result.text, result.images, model, storage),
                catch: (error) => error,
            });
        });
    }

    private getFullOCRTextEffect(): Effect.Effect<string, unknown> {
        const model = this.options.model;
        if (!model) {
            return Effect.fail(new Error("PDF full OCR requires an image-capable model"));
        }

        return Effect.gen(this, function* () {
            const content = yield* this.getBinaryEffect();
            return yield* extractFullOCRTextFromPDFEffect(content, model);
        });
    }

    private loadPDFEffect(): Effect.Effect<PDFDocumentLike, unknown> {
        return Effect.gen(this, function* () {
            const content = yield* this.getBinaryEffect();
            return yield* Effect.tryPromise({
                try: async () => (await PDF.load(new Uint8Array(content))) as unknown as PDFDocumentLike,
                catch: (error) => error,
            });
        });
    }

    private getBinaryEffect(): Effect.Effect<ArrayBuffer, unknown> {
        return Effect.tryPromise({
            try: () => this.options.loader.getBinary(),
            catch: (error) => error,
        });
    }
}
