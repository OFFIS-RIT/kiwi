import { describe, expect, test } from "bun:test";
import { getPDFPageGeometry } from "../page-geometry";
import { regionForBoundingBox } from "../source-reference";
import type { PDFArrayLike, PDFDictLike, PDFDocumentLike, PDFPageLike } from "../types";

const pdf: PDFDocumentLike = {
    getPages: () => [],
    getObject: (ref) => ref,
};

describe("getPDFPageGeometry", () => {
    test("uses the media box extents and origin", () => {
        const geometry = getPDFPageGeometry(pdf, fakePage({ MediaBox: [9, 9, 604, 801] }));

        expect(geometry.renderBox).toEqual({ x: 9, y: 9, width: 595, height: 792 });
        expect(geometry.renderedWidth).toBe(595);
        expect(geometry.renderedHeight).toBe(792);
        expect(geometry.rotation).toBe(0);
    });

    test("intersects the crop box with the media box", () => {
        const geometry = getPDFPageGeometry(
            pdf,
            fakePage({ MediaBox: [0, 0, 612, 792], CropBox: [-10, 100, 500, 900] })
        );

        expect(geometry.renderBox).toEqual({ x: 0, y: 100, width: 500, height: 692 });
    });

    test("falls back to the media box for a degenerate crop box", () => {
        const geometry = getPDFPageGeometry(
            pdf,
            fakePage({ MediaBox: [0, 0, 612, 792], CropBox: [700, 800, 700, 800] })
        );

        expect(geometry.renderBox).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    });

    test("inherits boxes and rotation from parent pages and normalizes negative angles", () => {
        const parent = fakeDict({ MediaBox: pdfNumberArray([0, 0, 612, 792]), Rotate: pdfNumber(-90) });
        const geometry = getPDFPageGeometry(pdf, fakePage({}, parent));

        expect(geometry.renderBox).toEqual({ x: 0, y: 0, width: 612, height: 792 });
        expect(geometry.rotation).toBe(270);
        expect(geometry.renderedWidth).toBe(792);
        expect(geometry.renderedHeight).toBe(612);
    });
});

describe("regionForBoundingBox", () => {
    test("maps a bbox on an unrotated page", () => {
        const geometry = getPDFPageGeometry(pdf, fakePage({ MediaBox: [0, 0, 612, 792] }));
        const region = requireRegion(
            regionForBoundingBox("text", geometry, { x: 61.2, y: 712.8, width: 122.4, height: 39.6 })
        );

        expect(region.page).toBe(1);
        expect(region.width).toBe(612);
        expect(region.height).toBe(792);
        expect(region.rectangles[0]!.left).toBeCloseTo(0.1);
        expect(region.rectangles[0]!.top).toBeCloseTo(0.05);
        expect(region.rectangles[0]!.width).toBeCloseTo(0.2);
        expect(region.rectangles[0]!.height).toBeCloseTo(0.05);
    });

    test("subtracts the render box origin", () => {
        const geometry = getPDFPageGeometry(pdf, fakePage({ MediaBox: [9, 9, 604, 801] }));
        const region = requireRegion(regionForBoundingBox("text", geometry, { x: 9, y: 9, width: 595, height: 792 }));

        expect(region.rectangles[0]).toEqual({ left: 0, top: 0, width: 1, height: 1 });
    });

    test("clips rectangles that partially overlap the crop box", () => {
        const geometry = getPDFPageGeometry(
            pdf,
            fakePage({ MediaBox: [0, 0, 612, 792], CropBox: [100, 200, 500, 700] })
        );
        const region = requireRegion(regionForBoundingBox("text", geometry, { x: 90, y: 250, width: 40, height: 20 }));

        expect(region.rectangles[0]!.left).toBeCloseTo(0);
        expect(region.rectangles[0]!.top).toBeCloseTo(430 / 500);
        expect(region.rectangles[0]!.width).toBeCloseTo(30 / 400);
        expect(region.rectangles[0]!.height).toBeCloseTo(20 / 500);
    });

    test("drops rectangles that are fully outside the crop box", () => {
        const geometry = getPDFPageGeometry(
            pdf,
            fakePage({ MediaBox: [0, 0, 612, 792], CropBox: [100, 200, 500, 700] })
        );

        expect(regionForBoundingBox("text", geometry, { x: 10, y: 20, width: 40, height: 20 })).toBeNull();
    });

    test("rotates rectangles for 90 degree pages", () => {
        const geometry = getPDFPageGeometry(pdf, fakePage({ MediaBox: [0, 0, 612, 792], Rotate: 90 }));
        const region = requireRegion(regionForBoundingBox("text", geometry, { x: 0, y: 0, width: 10, height: 20 }));

        expect(region.width).toBe(792);
        expect(region.height).toBe(612);
        expect(region.rectangles[0]!.left).toBeCloseTo(0);
        expect(region.rectangles[0]!.top).toBeCloseTo(0);
        expect(region.rectangles[0]!.width).toBeCloseTo(20 / 792);
        expect(region.rectangles[0]!.height).toBeCloseTo(10 / 612);
    });

    test("rotates rectangles for 180 degree pages", () => {
        const geometry = getPDFPageGeometry(pdf, fakePage({ MediaBox: [0, 0, 612, 792], Rotate: 180 }));
        const region = requireRegion(regionForBoundingBox("text", geometry, { x: 0, y: 0, width: 10, height: 20 }));

        expect(region.rectangles[0]!.left).toBeCloseTo(602 / 612);
        expect(region.rectangles[0]!.top).toBeCloseTo(0);
        expect(region.rectangles[0]!.width).toBeCloseTo(10 / 612);
        expect(region.rectangles[0]!.height).toBeCloseTo(20 / 792);
    });

    test("rotates rectangles for 270 degree pages", () => {
        const geometry = getPDFPageGeometry(pdf, fakePage({ MediaBox: [0, 0, 612, 792], Rotate: 270 }));
        const region = requireRegion(regionForBoundingBox("text", geometry, { x: 0, y: 0, width: 10, height: 20 }));

        expect(region.rectangles[0]!.left).toBeCloseTo(772 / 792);
        expect(region.rectangles[0]!.top).toBeCloseTo(602 / 612);
        expect(region.rectangles[0]!.width).toBeCloseTo(20 / 792);
        expect(region.rectangles[0]!.height).toBeCloseTo(10 / 612);
    });
});

function requireRegion(
    region: ReturnType<typeof regionForBoundingBox>
): NonNullable<ReturnType<typeof regionForBoundingBox>> {
    if (!region) {
        throw new Error("Expected region");
    }

    return region;
}

function fakePage(values: Record<string, unknown>, parent?: PDFDictLike): PDFPageLike {
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
        entries[key] = Array.isArray(value) ? pdfNumberArray(value as number[]) : pdfNumber(value as number);
    }
    if (parent) {
        entries.Parent = parent;
    }

    return {
        index: 0,
        width: 0,
        height: 0,
        dict: fakeDict(entries),
        getResources: () => fakeDict({}),
        extractText: () => ({ pageIndex: 0, width: 0, height: 0, lines: [], text: "" }),
    };
}

function fakeDict(values: Record<string, unknown>): PDFDictLike {
    return {
        type: "dict",
        get: (key) => values[typeof key === "string" ? key : key.value],
        getArray: (key) => {
            const value = values[key];
            return typeof value === "object" && value !== null && (value as { type?: string }).type === "array"
                ? (value as PDFArrayLike)
                : undefined;
        },
        getDict: (key) => {
            const value = values[key];
            return typeof value === "object" && value !== null && (value as { type?: string }).type === "dict"
                ? (value as PDFDictLike)
                : undefined;
        },
        getName: () => undefined,
        getNumber: (key) => {
            const value = values[key];
            return typeof value === "object" && value !== null && (value as { type?: string }).type === "number"
                ? (value as { type: "number"; value: number })
                : undefined;
        },
        *[Symbol.iterator]() {
            for (const [key, value] of Object.entries(values)) {
                yield [{ type: "name", value: key }, value] as [{ type: "name"; value: string }, unknown];
            }
        },
    };
}

function pdfNumber(value: number): { type: "number"; value: number } {
    return { type: "number", value };
}

function pdfNumberArray(values: number[]): PDFArrayLike {
    const items = values.map(pdfNumber);

    return {
        type: "array",
        length: items.length,
        at: (index) => items[index],
        *[Symbol.iterator]() {
            yield* items;
        },
    };
}
