import { describe, expect, test } from "bun:test";

import { buildPDFLoaderOptions } from "../pdf-loader";

describe("buildPDFLoaderOptions", () => {
    test("builds full OCR PDF loader options without storage", async () => {
        const loader = {
            getText: async () => "",
            getBinary: async () => new Uint8Array([1]).buffer,
        };
        const model = {} as never;

        const options = buildPDFLoaderOptions(loader, model);

        expect(options.loader).toBe(loader);
        expect(options.mode).toBe("ocr");
        expect(options.model).toBe(model);
        expect("storage" in options).toBe(false);
    });

    test("throws when the image model is missing", () => {
        const loader = {
            getText: async () => "",
            getBinary: async () => new Uint8Array([1]).buffer,
        };

        expect(() => buildPDFLoaderOptions(loader, undefined)).toThrow("PDF full OCR requires an image-capable model");
    });
});
