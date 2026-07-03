import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_RASTER_SCALE } from "../constants";
import { getPageOCRRotation, shouldUsePageOCRFallback } from "../document";
import { extractOCRTextFromPDFPages, getPageRasterScale } from "../ocr";
import type {
    BoundingBox,
    Edge,
    ImageOccurrence,
    PageContentAnalysis,
    PageText,
    PDFOCRPageSelection,
    TextChar,
    TextLine,
} from "../types";

const TWO_PIXEL_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=";

function pngSize(image: Uint8Array): string {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    return `${view.getUint32(16, false)}x${view.getUint32(20, false)}`;
}

function bboxForChars(chars: TextChar[]): BoundingBox {
    const left = Math.min(...chars.map((char) => char.bbox.x));
    const right = Math.max(...chars.map((char) => char.bbox.x + char.bbox.width));
    const bottom = Math.min(...chars.map((char) => char.bbox.y));
    const top = Math.max(...chars.map((char) => char.bbox.y + char.bbox.height));

    return { x: left, y: bottom, width: right - left, height: top - bottom };
}

function verticalLine(text: string, x: number, y: number, sequenceStart: number): TextLine {
    const chars = Array.from(text, (char, index): TextChar => {
        const baseline = y + index * 6;
        return {
            char,
            bbox: { x, y: baseline, width: 8, height: 5 },
            fontSize: 8,
            fontName: "Helvetica",
            baseline,
            sequenceIndex: sequenceStart + index,
        };
    });
    const bbox = bboxForChars(chars);

    return {
        text,
        bbox,
        baseline: chars[0]?.baseline ?? bbox.y,
        spans: [
            {
                text,
                bbox,
                chars,
                fontSize: 8,
                fontName: "Helvetica",
            },
        ],
    };
}

function horizontalLine(text: string, x: number, y: number, sequenceStart: number): TextLine {
    const chars = Array.from(text, (char, index): TextChar => {
        const charX = x + index * 5;
        return {
            char,
            bbox: { x: charX, y, width: 5, height: 8 },
            fontSize: 8,
            fontName: "Helvetica",
            baseline: y + 8,
            sequenceIndex: sequenceStart + index,
        };
    });
    const bbox = bboxForChars(chars);

    return {
        text,
        bbox,
        baseline: y + 8,
        spans: [
            {
                text,
                bbox,
                chars,
                fontSize: 8,
                fontName: "Helvetica",
            },
        ],
    };
}

function rectGridEdges(xs: number[], ys: number[]): Edge[] {
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const bottom = Math.min(...ys);
    const top = Math.max(...ys);

    return [
        ...xs.map((x): Edge => ({ orientation: "vertical", position: x, start: bottom, end: top, source: "rect" })),
        ...ys.map((y): Edge => ({ orientation: "horizontal", position: y, start: left, end: right, source: "rect" })),
    ];
}

function rotatedTablePage(): { pageText: PageText; content: PageContentAnalysis } {
    const xs = [40, 100, 160, 220];
    const ys = [40, 80, 120, 160, 200];
    const lines: TextLine[] = [];
    let sequence = 0;
    for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 3; column += 1) {
            const text = `R${row + 1}C${column + 1}`;
            lines.push(verticalLine(text, xs[column]! + 16, ys[row]! + 12, sequence));
            sequence += text.length;
        }
    }

    return {
        pageText: {
            pageIndex: 0,
            width: 260,
            height: 220,
            text: lines.map((line) => line.text).join("\n"),
            lines,
        },
        content: {
            images: [],
            explicitEdges: rectGridEdges(xs, ys),
            actualTextSpans: [],
        },
    };
}

function sparseRotatedTablePage(): { pageText: PageText; content: PageContentAnalysis } {
    const xs = [40, 120, 220];
    const ys = [40, 80, 120, 160, 200];
    const lines: TextLine[] = [];
    let sequence = 0;
    for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 3; column += 1) {
            const text = `T${row + 1}-${column + 1}`;
            const x = xs[Math.min(column, xs.length - 2)]! + 16 + column * 10;
            lines.push(verticalLine(text, x, ys[row]! + 12, sequence));
            sequence += text.length;
        }
    }

    return {
        pageText: {
            pageIndex: 0,
            width: 260,
            height: 220,
            text: lines.map((line) => line.text).join("\n"),
            lines,
        },
        content: {
            images: [],
            explicitEdges: rectGridEdges(xs, ys),
            actualTextSpans: [],
        },
    };
}

function denseMixedDrawnGridPage(): { pageText: PageText; content: PageContentAnalysis } {
    const xs = [30, 100, 170, 240, 310];
    const ys = [40, 100, 160, 220, 280, 340, 400];
    const lines: TextLine[] = [];
    let sequence = 0;

    for (let row = 0; row < ys.length - 1; row += 1) {
        for (let column = 0; column < xs.length - 1; column += 1) {
            const vertical = row < 2 || (row === 2 && column < 2);
            const text = vertical ? `V${row + 1}${column + 1}A` : `Habitat-${row + 1}${column + 1}-AB`;
            lines.push(
                vertical
                    ? verticalLine(text, xs[column]! + 18, ys[row]! + 10, sequence)
                    : horizontalLine(text, xs[column]! + 4, ys[row]! + 24, sequence)
            );
            sequence += text.length;
        }
    }

    return {
        pageText: {
            pageIndex: 0,
            width: 340,
            height: 460,
            text: lines.map((line) => line.text).join("\n"),
            lines,
        },
        content: {
            images: [],
            explicitEdges: rectGridEdges(xs, ys),
            actualTextSpans: [],
        },
    };
}

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

    test("keeps image-heavy pages with extracted caption and body text on the hybrid text path", () => {
        const extractedLines = [
            "Figure 1: Generic assembly view with labeled reference markers for review.",
            "Caption: Synthetic component photo documents bracket placement and clearances.",
            "Body text notes describe repeatable setup measurements for the sample page.",
            "Additional extracted text keeps the page above the image-only OCR threshold.",
        ];

        expect(shouldUsePageOCRFallback(pageText(extractedLines), contentWithImages(4))).toBe(false);
    });

    test("uses full-page OCR for alpha-fragmented extracted text", () => {
        const fragmentedLines = Array.from({ length: 24 }, (_, index) =>
            [
                "Th e sa mp le co mp on en t is de si gn ed fo r ac cu ra te te st re su lt s",
                "with ca li br at ed pi ec es and ge ne ri c ap pl ic at io n no te s",
                `line ${index}`,
            ].join(" ")
        );

        expect(shouldUsePageOCRFallback(pageText(fragmentedLines), contentWithImages(0))).toBe(true);
    });

    test("uses full-page OCR for alpha-fragmented long paragraphs", () => {
        const fragmentedLines = [
            Array.from({ length: 10 }, () =>
                [
                    "S y n th et ic De mo Pa ra gr ap h th ro ug h a te st fi xt ur e",
                    "de li ve rs a cl ea n si gn al wi th a sm al l ga p si ze",
                    "to va li da te ma nu al sp ac in g and wo rd bo un da ri es.",
                ].join(" ")
            ).join(" "),
        ];

        expect(shouldUsePageOCRFallback(pageText(fragmentedLines), contentWithImages(0))).toBe(true);
    });

    test("keeps detected rotated drawn table pages on the hybrid text path", () => {
        const fixture = rotatedTablePage();

        expect(shouldUsePageOCRFallback(fixture.pageText, fixture.content)).toBe(false);
    });

    test("keeps dense drawn-grid pages with extracted table text on the hybrid text path", () => {
        const fixture = denseMixedDrawnGridPage();

        expect(shouldUsePageOCRFallback(fixture.pageText, fixture.content)).toBe(false);
    });

    test("keeps substantial drawn table text on the hybrid text path", () => {
        const lines: TextLine[] = [];
        let sequence = 0;
        for (let index = 0; index < 12; index += 1) {
            const text = `Sample row ${String(index + 1).padStart(2, "0")} metric`;
            lines.push(verticalLine(text, 60 + (index % 4) * 40, 40 + Math.floor(index / 4) * 80, sequence));
            sequence += text.length;
        }
        const fixture: PageText = {
            pageIndex: 0,
            width: 260,
            height: 320,
            text: lines.map((line) => line.text).join("\n"),
            lines,
        };
        const content: PageContentAnalysis = {
            images: [],
            explicitEdges: rectGridEdges([40, 100, 160, 220], [20, 60, 100, 140, 180, 220, 260, 300]),
            actualTextSpans: [],
        };

        expect(shouldUsePageOCRFallback(fixture, content)).toBe(false);
    });

    test("uses full-page OCR for vertical fragments without a detected drawn table", () => {
        const fixture = rotatedTablePage();

        expect(shouldUsePageOCRFallback(fixture.pageText, { ...fixture.content, explicitEdges: [] })).toBe(true);
    });

    test("keeps normal technical prose on the hybrid text path", () => {
        const proseLines = Array.from({ length: 24 }, (_, index) =>
            [
                "The generic component is designed for repeatable measurements with stable mounting.",
                "Calibration values and interface notes are listed in the following sections.",
                `Reference line ${index}`,
            ].join(" ")
        );

        expect(shouldUsePageOCRFallback(pageText(proseLines), contentWithImages(0))).toBe(false);
    });
});

describe("getPageOCRRotation", () => {
    test("only rotates OCR pages with a high-confidence vertical drawn table", () => {
        const fixture = rotatedTablePage();

        expect(getPageOCRRotation(fixture.pageText, fixture.content)).toBe(90);
        expect(getPageOCRRotation(fixture.pageText, { ...fixture.content, explicitEdges: [] })).toBe(0);
    });

    test("rotates sparse vertical table fallback pages", () => {
        const fixture = sparseRotatedTablePage();

        expect(getPageOCRRotation(fixture.pageText, fixture.content)).toBe(90);
    });
});
describe("getPageRasterScale", () => {
    test("uses the 3.25 default raster scale when the rendered image stays under 3000px", () => {
        expect(getPageRasterScale({ width: 595.28, height: 841.89 })).toBe(DEFAULT_RASTER_SCALE);
    });

    test("caps default raster scales at 3000px on the longest edge", () => {
        expect(getPageRasterScale({ width: 1190.56, height: 1683.78 })).toBeCloseTo(3000 / 1683.78);
        expect(getPageRasterScale({ width: 3000, height: 1000 })).toBeCloseTo(1);
    });

    test("keeps retry scales relative to the 3.25 default unless they would exceed 3000px", () => {
        expect(getPageRasterScale({ width: 400, height: 600 }, DEFAULT_RASTER_SCALE * 1.25)).toBe(
            DEFAULT_RASTER_SCALE * 1.25
        );
        expect(getPageRasterScale({ width: 595.28, height: 841.89 }, DEFAULT_RASTER_SCALE * 1.25)).toBeCloseTo(
            3000 / 841.89
        );
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

    test("rotates vertical fallback pages before transcription", async () => {
        const transcribePage = mock(async (image: Uint8Array) => pngSize(image));
        const image = Uint8Array.from(Buffer.from(TWO_PIXEL_PNG_BASE64, "base64"));

        const textByPage = await extractOCRTextFromPDFPages(
            new Uint8Array([9]),
            [{ index: 0, width: 595.28, height: 841.89, ocrRotation: 90 }],
            {} as never,
            {
                rasterizeSelectedPages: async () => new Map([[0, image]]),
                transcribePage,
            }
        );

        expect(textByPage).toEqual(new Map([[0, "1x2"]]));
        expect(transcribePage).toHaveBeenCalledTimes(1);
    });

    test("retries length-limited rotated OCR pages at scale 2 before trying alternate rotation", async () => {
        const image = Uint8Array.from(Buffer.from(TWO_PIXEL_PNG_BASE64, "base64"));
        const rasterizeSelectedPages = mock(
            async (_content: Uint8Array, pages: PDFOCRPageSelection[], _scale?: number) =>
                new Map(pages.map((page) => [page.index, image] as const))
        );
        let attempts = 0;
        const transcribedSizes: string[] = [];
        const transcribePage = mock(async (transcribedImage: Uint8Array) => {
            attempts += 1;
            transcribedSizes.push(pngSize(transcribedImage));
            if (attempts < 3) {
                return { text: `partial ${attempts}`, finishReason: "length" as const };
            }

            return { text: pngSize(transcribedImage), finishReason: "stop" as const };
        });

        const textByPage = await extractOCRTextFromPDFPages(
            new Uint8Array([9]),
            [{ index: 0, width: 400, height: 600, ocrRotation: 90 }],
            {} as never,
            {
                rasterizeSelectedPages,
                transcribePage,
            }
        );

        expect(textByPage).toEqual(new Map([[0, "2x1"]]));
        expect(transcribePage).toHaveBeenCalledTimes(3);
        expect(transcribedSizes).toEqual(["1x2", "1x2", "2x1"]);
        expect(rasterizeSelectedPages.mock.calls.map((call) => call[2])).toEqual([3, 2]);
    });

    test("retries length-limited OCR pages with higher raster scales and rotation", async () => {
        const image = Uint8Array.from(Buffer.from(TWO_PIXEL_PNG_BASE64, "base64"));
        const rasterizeSelectedPages = mock(
            async (_content: Uint8Array, pages: PDFOCRPageSelection[], _scale?: number) =>
                new Map(pages.map((page) => [page.index, image] as const))
        );
        let attempts = 0;
        const transcribePage = mock(async (transcribedImage: Uint8Array) => {
            attempts += 1;
            if (attempts < 4) {
                return { text: `partial ${attempts}`, finishReason: "length" as const };
            }

            return { text: pngSize(transcribedImage), finishReason: "stop" as const };
        });

        const textByPage = await extractOCRTextFromPDFPages(
            new Uint8Array([9]),
            [{ index: 0, width: 400, height: 600 }],
            {} as never,
            {
                rasterizeSelectedPages,
                transcribePage,
            }
        );

        expect(textByPage).toEqual(new Map([[0, "1x2"]]));
        expect(transcribePage).toHaveBeenCalledTimes(4);
        expect(rasterizeSelectedPages.mock.calls.map((call) => call[2])).toEqual([
            undefined,
            DEFAULT_RASTER_SCALE * 1.25,
            DEFAULT_RASTER_SCALE * 1.5,
        ]);
    });

    test("caps retry raster scales at the max page dimension", async () => {
        const image = Uint8Array.from(Buffer.from(TWO_PIXEL_PNG_BASE64, "base64"));
        const rasterizeSelectedPages = mock(
            async (_content: Uint8Array, pages: PDFOCRPageSelection[], _scale?: number) =>
                new Map(pages.map((page) => [page.index, image] as const))
        );
        const transcribePage = mock(async () => ({ text: "partial page", finishReason: "length" as const }));

        const textByPage = await extractOCRTextFromPDFPages(
            new Uint8Array([9]),
            [{ index: 0, width: 3000, height: 1000 }],
            {} as never,
            {
                rasterizeSelectedPages,
                transcribePage,
            }
        );

        expect(textByPage).toEqual(new Map());
        expect(rasterizeSelectedPages.mock.calls.map((call) => call[2])).toEqual([undefined, 1, 1]);
    });
    test("skips OCR pages when every retry finishes because of length", async () => {
        const image = Uint8Array.from(Buffer.from(TWO_PIXEL_PNG_BASE64, "base64"));
        const rasterizeSelectedPages = mock(
            async (_content: Uint8Array, pages: PDFOCRPageSelection[], _scale?: number) =>
                new Map(pages.map((page) => [page.index, image] as const))
        );
        const transcribePage = mock(async () => ({ text: "partial page", finishReason: "length" as const }));

        const textByPage = await extractOCRTextFromPDFPages(
            new Uint8Array([9]),
            [{ index: 0, width: 400, height: 600 }],
            {} as never,
            {
                rasterizeSelectedPages,
                transcribePage,
            }
        );

        expect(textByPage).toEqual(new Map());
        expect(transcribePage).toHaveBeenCalledTimes(4);
        expect(rasterizeSelectedPages.mock.calls.map((call) => call[2])).toEqual([
            undefined,
            DEFAULT_RASTER_SCALE * 1.25,
            DEFAULT_RASTER_SCALE * 1.5,
        ]);
    });
});
