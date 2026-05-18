import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { processOCRImages } from "../lib/ocr-image";
import { parsePPT } from "./ppt/parser/document";
import { renderMarkdown } from "./ppt/parser/render";

export class PPTXLoader implements GraphLoader {
    readonly filetype = "pptx";
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
        const parsed = await parsePPT(content, false);
        return renderMarkdown(parsed.slides);
    }

    private async getOCRText(): Promise<string> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            throw new Error("PPTX OCR requires an image model and storage configuration");
        }

        const content = await this.options.loader.getBinary();
        const parsed = await parsePPT(content, true);
        const markdown = renderMarkdown(parsed.slides);
        return processOCRImages(markdown, parsed.images, model, storage);
    }
}
