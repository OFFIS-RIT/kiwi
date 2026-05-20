import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_RASTER_SCALE } from "../constants";
import { shouldUsePageOCRFallback } from "../document";
import { extractOCRTextFromPDFPages, getPageRasterScale } from "../ocr";
import type { ImageOccurrence, PageContentAnalysis, PageText } from "../types";

function pageText(lines: string[]): PageText {
    return {
        pageIndex: 0,
        width: 595.28,
        height: 841.89,
        text: lines.join("\n"),
        lines: lines.map((text, index) => ({
            text,
            bbox: { x: 0, y: index * 12, width: text.length * 6, height: 12 },
            spans: [
                {
                    text,
                    bbox: { x: 0, y: index * 12, width: text.length * 6, height: 12 },
                    chars: [],
                    fontSize: 12,
                    fontName: "Helvetica",
                },
            ],
            baseline: index * 12,
        })),
    };
}

function contentWithImages(count: number): PageContentAnalysis {
    return {
        images: Array.from(
            { length: count },
            (_, index): ImageOccurrence => ({
                id: `img-${index + 1}`,
                type: "image/png",
                content: new Uint8Array([index]),
                bbox: { x: 0, y: 0, width: 10, height: 10 },
                pageIndex: 0,
            })
        ),
        explicitEdges: [],
        actualTextSpans: [],
    };
}

function contentWithImageBox(width: number, height: number): PageContentAnalysis {
    return {
        images: [
            {
                id: "img-1",
                type: "image/png",
                content: new Uint8Array([1]),
                bbox: { x: 0, y: 0, width, height },
                pageIndex: 0,
            },
        ],
        explicitEdges: [],
        actualTextSpans: [],
    };
}

describe("shouldUsePageOCRFallback", () => {
    test("uses full-page OCR for image pages without text", () => {
        expect(shouldUsePageOCRFallback(pageText([]), contentWithImageBox(595.28, 841.89))).toBe(true);
        expect(shouldUsePageOCRFallback(pageText([]), contentWithImages(1))).toBe(false);
        expect(shouldUsePageOCRFallback(pageText([]), contentWithImages(0))).toBe(false);
    });
});

describe("getPageRasterScale", () => {
    test("caps large pages while keeping raster dimensions below 2000px", () => {
        expect(getPageRasterScale({ width: 595.28, height: 841.89 })).toBe(DEFAULT_RASTER_SCALE);
        expect(getPageRasterScale({ width: 595.28 * 1.2, height: 841.89 * 1.2 })).toBeCloseTo(0.75);
        expect(getPageRasterScale({ width: 3000, height: 1000 })).toBeCloseTo(2000 / 3000);
    });
});

describe("extractOCRTextFromPDFPages", () => {
    test("skips requested pages that are missing from selected rasterization output", async () => {
        const transcribePage = mock(async (image: Uint8Array) => `Page ${image[0]}`);

        const textByPage = await extractOCRTextFromPDFPages(
            new Uint8Array([9]),
            [
                { index: 0, width: 595.28, height: 841.89 },
                { index: 1, width: 595.28, height: 841.89 },
            ],
            {} as never,
            {
                rasterizeSelectedPages: async () => new Map([[1, new Uint8Array([2])]]),
                transcribePage,
            }
        );

        expect(textByPage).toEqual(new Map([[1, "Page 2"]]));
        expect(transcribePage).toHaveBeenCalledTimes(1);
    });
});
