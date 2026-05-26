import { beforeEach, describe, expect, mock, test } from "bun:test";

let activePageReads = 0;
let maxActivePageReads = 0;
const pdfToImgMock = mock(async () => ({
    getPage: async (pageNumber: number) => {
        activePageReads += 1;
        maxActivePageReads = Math.max(maxActivePageReads, activePageReads);
        await Promise.resolve();
        activePageReads -= 1;
        return new Uint8Array([pageNumber]);
    },
}));

mock.module("pdf-to-img", () => ({
    pdf: pdfToImgMock,
}));

const {
    GhostscriptUnavailableError,
    rasterizeSelectedPDFPages,
    rasterizeSelectedPDFPagesWithPDFToImg,
    splitPagesIntoContiguousRanges,
} = await import("../rasterize");

describe("rasterizeSelectedPDFPages", () => {
    beforeEach(() => {
        activePageReads = 0;
        maxActivePageReads = 0;
        pdfToImgMock.mockClear();
    });

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

    test("splits requested pages into contiguous ranges", () => {
        const ranges = splitPagesIntoContiguousRanges([
            { index: 49 },
            { index: 0 },
            { index: 1 },
            { index: 4 },
            { index: 5 },
            { index: 5 },
        ]);

        expect(ranges.map((range) => range.map((page) => page.index))).toEqual([[0, 1], [4, 5], [49]]);
    });

    test("renders pdf-to-img fallback pages concurrently", async () => {
        const result = await rasterizeSelectedPDFPagesWithPDFToImg(
            new Uint8Array([9]),
            [{ index: 0 }, { index: 1 }, { index: 2 }],
            1.5
        );

        expect(result).toEqual(
            new Map([
                [0, new Uint8Array([1])],
                [1, new Uint8Array([2])],
                [2, new Uint8Array([3])],
            ])
        );
        expect(maxActivePageReads).toBe(3);
        expect(pdfToImgMock).toHaveBeenCalledTimes(1);
    });
});
