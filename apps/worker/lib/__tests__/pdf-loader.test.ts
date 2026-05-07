import { describe, expect, test } from "bun:test";

import { buildPDFLoaderOptions } from "../pdf-loader";

describe("buildPDFLoaderOptions", () => {
    test("builds hybrid PDF loader options with storage", async () => {
        const loader = {
            getText: async () => "",
            getBinary: async () => new Uint8Array([1]).buffer,
        };
        const model = {} as never;
        const storage = { bucket: "bucket", imagePrefix: "graphs/graph-1/files/file-1/images" };

        const options = buildPDFLoaderOptions(loader, model, storage);

        expect(options.loader).toBe(loader);
        expect(options.mode).toBe("hybrid");
        expect(options.model).toBe(model);
        expect(options.storage).toBe(storage);
    });

    test("throws when the image model is missing", () => {
        const loader = {
            getText: async () => "",
            getBinary: async () => new Uint8Array([1]).buffer,
        };
        const storage = { bucket: "bucket", imagePrefix: "graphs/graph-1/files/file-1/images" };

        expect(() => buildPDFLoaderOptions(loader, undefined, storage)).toThrow(
            "PDF hybrid mode requires an image-capable model"
        );
    });
});
