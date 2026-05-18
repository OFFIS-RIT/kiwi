import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { processOCRImages } from "../lib/ocr-image";
import { extractPDFHybridFromDocument, extractPlainTextFromDocument } from "./pdf/parser/document";
import { extractFullOCRTextFromPDF } from "./pdf/parser/ocr";
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

        return this.getPlainText();
    }

    private async getModeText(mode: Exclude<PDFMode, "plain">): Promise<string> {
        return mode === "hybrid" ? this.getHybridText() : this.getFullOCRText();
    }

    private async getPlainText(): Promise<string> {
        const pdf = await this.loadPDF();
        return extractPlainTextFromDocument(pdf);
    }

    private async getHybridText(): Promise<string> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            throw new Error("PDF hybrid mode requires an image model and storage configuration");
        }

        const pdf = await this.loadPDF();
        const result = extractPDFHybridFromDocument(pdf, {
            tableMode: this.options.tableMode,
        });
        return processOCRImages(result.text, result.images, model, storage);
    }

    private async getFullOCRText(): Promise<string> {
        const model = this.options.model;
        if (!model) {
            throw new Error("PDF full OCR requires an image-capable model");
        }

        const content = await this.options.loader.getBinary();
        return extractFullOCRTextFromPDF(content, model);
    }

    private async loadPDF(): Promise<PDFDocumentLike> {
        const content = await this.options.loader.getBinary();
        return (await PDF.load(new Uint8Array(content))) as unknown as PDFDocumentLike;
    }
}
