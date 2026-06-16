import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { GraphBinaryLoader, GraphLoader } from "../types";
import { processOCRImages } from "../lib/ocr-image";
import { parseDOCX } from "./doc/document";
import { renderMarkdown } from "./doc/render";

export class DOCXLoader implements GraphLoader {
    readonly filetype = "docx";
    private cachedOCRText?: Promise<string>;

    constructor(
        private options: {
            loader: GraphBinaryLoader;
            ocr?: boolean;
            model?: LanguageModelV3;
            storage?: { bucket: string; imagePrefix: string };
        }
    ) {}

    async getText(): Promise<string> {
        if (this.options.ocr) {
            this.cachedOCRText ??= this.getOCRText();
            return this.cachedOCRText;
        }

        return this.getPlainText();
    }

    private async getPlainText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const parsed = await parseDOCX(content, { ocr: false, markdown: true });
        return renderMarkdown(parsed.blocks);
    }

    private async getOCRText(): Promise<string> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            throw new Error("DOCX OCR requires an image model and storage configuration");
        }

        const content = await this.options.loader.getBinary();
        const parsed = await parseDOCX(content, { ocr: true, markdown: true });
        const markdown = renderMarkdown(parsed.blocks);
        return processOCRImages(markdown, parsed.images, model, storage);
    }
}
