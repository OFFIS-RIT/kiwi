import { describe, expect, mock, test } from "bun:test";
import { GhostscriptUnavailableError, rasterizeSelectedPDFPages } from "../rasterize";

describe("rasterizeSelectedPDFPages", () => {
    const pages = [{ index: 1, width: 600, height: 800 }];

    test("uses Ghostscript when available", async () => {
        const ghostscript = mock(async () => new Map([[1, new Uint8Array([1])]]));
        const pdfToImg = mock(async () => new Map([[1, new Uint8Array([2])]]));

        const result = await rasterizeSelectedPDFPages(new Uint8Array([9]), pages, 1.5, {
            ghostscript,
            pdfToImg,
        });

        expect(result).toEqual(new Map([[1, new Uint8Array([1])]]));
        expect(ghostscript).toHaveBeenCalledTimes(1);
        expect(pdfToImg).not.toHaveBeenCalled();
    });

    test("falls back to pdf-to-img when Ghostscript is unavailable", async () => {
        const ghostscript = mock(async () => {
            throw new GhostscriptUnavailableError("missing gs");
        });
        const pdfToImg = mock(async () => new Map([[1, new Uint8Array([2])]]));

        const result = await rasterizeSelectedPDFPages(new Uint8Array([9]), pages, 1.5, {
            ghostscript,
            pdfToImg,
        });

        expect(result).toEqual(new Map([[1, new Uint8Array([2])]]));
        expect(ghostscript).toHaveBeenCalledTimes(1);
        expect(pdfToImg).toHaveBeenCalledTimes(1);
    });
});
