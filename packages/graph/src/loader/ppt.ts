import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Effect } from "effect";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { processOCRImages } from "../lib/ocr-image";
import { parsePPTEffect } from "./ppt/parser/document";
import { renderMarkdownEffect } from "./ppt/parser/render";

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
            this.cachedOCRText ??= Effect.runPromise(this.getOCRTextEffect());
            return this.cachedOCRText;
        }

        return Effect.runPromise(this.getPlainTextEffect());
    }

    private getPlainTextEffect(): Effect.Effect<string, unknown> {
        return Effect.gen(this, function* () {
            const content = yield* this.getBinaryEffect();
            const parsed = yield* parsePPTEffect(content, false);
            return yield* renderMarkdownEffect(parsed.slides);
        });
    }

    private getOCRTextEffect(): Effect.Effect<string, unknown> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            return Effect.fail(new Error("PPTX OCR requires an image model and storage configuration"));
        }

        return Effect.gen(this, function* () {
            const content = yield* this.getBinaryEffect();
            const parsed = yield* parsePPTEffect(content, true);
            const markdown = yield* renderMarkdownEffect(parsed.slides);
            return yield* Effect.tryPromise({
                try: () => processOCRImages(markdown, parsed.images, model, storage),
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
