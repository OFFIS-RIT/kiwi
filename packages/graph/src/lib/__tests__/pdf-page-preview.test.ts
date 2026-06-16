import { describe, expect, mock, test } from "bun:test";
import { renderPDFPagePreviews } from "../pdf-page-preview";
import type { PDFDocumentLike, PDFPageLike } from "@kiwi/loaders/loader/pdf/types";

function pdfWithPages(pages: Array<Pick<PDFPageLike, "index" | "width" | "height">>): PDFDocumentLike {
    return {
        getPages: () => pages as PDFPageLike[],
        getObject: () => null,
    };
}

describe("renderPDFPagePreviews", () => {
    test("renders requested 1-based pages", async () => {
        const rasterizeSelectedPages = mock(
            async () =>
                new Map([
                    [0, new Uint8Array([1])],
                    [2, new Uint8Array([3])],
                ])
        );
        const previews = await renderPDFPagePreviews(
            new Uint8Array([9]),
            [1, 3],
            {},
            {
                loadPDF: async () =>
                    pdfWithPages([
                        { index: 0, width: 600, height: 800 },
                        { index: 1, width: 600, height: 800 },
                        { index: 2, width: 600, height: 800 },
                    ]),
                rasterizeSelectedPages,
            }
        );

        expect([...previews.entries()]).toEqual([
            [1, new Uint8Array([1])],
            [3, new Uint8Array([3])],
        ]);
        expect(rasterizeSelectedPages.mock.calls[0]?.[1].map((page) => page.index)).toEqual([0, 2]);
    });

    test("rejects invalid page numbers", async () => {
        await expect(
            renderPDFPagePreviews(new Uint8Array([9]), [0], {}, { loadPDF: async () => pdfWithPages([]) })
        ).rejects.toThrow("Invalid PDF page number 0");
    });

    test("skips pages beyond the PDF page count", async () => {
        const rasterizeSelectedPages = mock(async () => new Map([[0, new Uint8Array([1])]]));
        const previews = await renderPDFPagePreviews(
            new Uint8Array([9]),
            [1, 5],
            {},
            {
                loadPDF: async () => pdfWithPages([{ index: 0, width: 600, height: 800 }]),
                rasterizeSelectedPages,
            }
        );

        expect([...previews.entries()]).toEqual([[1, new Uint8Array([1])]]);
        expect(rasterizeSelectedPages.mock.calls[0]?.[1].map((page) => page.index)).toEqual([0]);
    });

    test("caps preview scale by maximum page dimension", async () => {
        const rasterizeSelectedPages = mock(async () => new Map([[0, new Uint8Array([1])]]));

        await renderPDFPagePreviews(
            new Uint8Array([9]),
            [1],
            { scale: 1.5, maxDimensionPixels: 2400 },
            {
                loadPDF: async () => pdfWithPages([{ index: 0, width: 1000, height: 3000 }]),
                rasterizeSelectedPages,
            }
        );

        expect(rasterizeSelectedPages.mock.calls[0]?.[2]).toBeCloseTo(0.8);
    });
});
