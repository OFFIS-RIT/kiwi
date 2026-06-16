import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { GraphBinaryLoader, GraphDocumentLoader, LoadedGraphDocument } from "../types";
import { extractFullOCRDocumentFromPDF, extractPDFDocumentFromDocument } from "./pdf/document";
import type { PDFDocumentLike, PDFTableMode } from "./pdf/types";

export { extractFullOCRTextFromPDF } from "./pdf/ocr";
export type PDFMode = "plain" | "hybrid" | "ocr";
export type { PDFTableMode } from "./pdf/types";

export class PDFLoader implements GraphDocumentLoader {
    readonly filetype = "pdf";
    private cachedDocument?: Promise<LoadedGraphDocument>;

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
        return (await this.getDocument()).text;
    }

    async getDocument(): Promise<LoadedGraphDocument> {
        const mode = this.options.mode ?? "plain";
        this.cachedDocument ??= this.getModeDocument(mode);
        return this.cachedDocument;
    }

    private async getModeDocument(mode: PDFMode): Promise<LoadedGraphDocument> {
        switch (mode) {
            case "hybrid":
                return this.getHybridDocument();
            case "ocr":
                return this.getFullOCRDocument();
            case "plain":
                return this.getPlainDocument();
        }
    }

    private async getPlainDocument(): Promise<LoadedGraphDocument> {
        const pdf = await this.loadPDF();
        return extractPDFDocumentFromDocument(pdf, { mode: "plain" });
    }

    private async getHybridDocument(): Promise<LoadedGraphDocument> {
        const model = this.options.model;
        if (!model) {
            throw new Error("PDF hybrid mode requires an image model");
        }

        const content = await this.options.loader.getBinary();
        const pdf = await this.loadPDF(content);
        return extractPDFDocumentFromDocument(pdf, {
            mode: "hybrid",
            tableMode: this.options.tableMode,
            ocrFallback: {
                content: new Uint8Array(content),
                model,
            },
        });
    }

    private async getFullOCRDocument(): Promise<LoadedGraphDocument> {
        const model = this.options.model;
        if (!model) {
            throw new Error("PDF full OCR requires an image-capable model");
        }

        const content = await this.options.loader.getBinary();
        const pdf = await this.loadPDF(content);
        return extractFullOCRDocumentFromPDF(new Uint8Array(content), pdf, model);
    }

    private async loadPDF(content?: ArrayBuffer): Promise<PDFDocumentLike> {
        content ??= await this.options.loader.getBinary();
        return (await PDF.load(new Uint8Array(content))) as unknown as PDFDocumentLike;
    }
}
