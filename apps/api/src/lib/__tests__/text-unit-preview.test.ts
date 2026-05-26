import { describe, expect, test } from "bun:test";
import {
    buildTextUnitPreview,
    getPdfPreviewPageNumbers,
    MAX_PDF_PREVIEW_PAGES,
    parsePageImageParam,
} from "../text-unit-preview";

describe("buildTextUnitPreview", () => {
    test("returns PDF page preview metadata for PDF units with page spans", () => {
        expect(
            buildTextUnitPreview({
                graphId: "graph-1",
                unitId: "unit-1",
                fileType: "pdf",
                startPage: 2,
                endPage: 3,
            })
        ).toEqual({
            type: "pdf_pages",
            start_page: 2,
            end_page: 3,
            pages: [
                { page: 2, image_path: "/graphs/graph-1/units/unit-1/pages/2.png" },
                { page: 3, image_path: "/graphs/graph-1/units/unit-1/pages/3.png" },
            ],
        });
    });

    test("returns no preview for non-PDF units and missing page spans", () => {
        expect(
            buildTextUnitPreview({
                graphId: "graph-1",
                unitId: "unit-1",
                fileType: "doc",
                startPage: 2,
                endPage: 3,
            })
        ).toEqual({ type: "none" });
        expect(
            buildTextUnitPreview({
                graphId: "graph-1",
                unitId: "unit-1",
                fileType: "pdf",
                startPage: null,
                endPage: null,
            })
        ).toEqual({ type: "none" });
    });

    test("caps large PDF spans to a bounded preview window", () => {
        const preview = buildTextUnitPreview({
            graphId: "graph-1",
            unitId: "unit-1",
            fileType: "pdf",
            startPage: 10,
            endPage: 30,
        });

        expect(preview).toMatchObject({
            type: "pdf_pages",
            start_page: 10,
            end_page: 30,
        });
        expect(preview.type === "pdf_pages" ? preview.pages.map((page) => page.page) : []).toEqual(
            Array.from({ length: MAX_PDF_PREVIEW_PAGES }, (_, index) => 10 + index)
        );
    });
});

describe("getPdfPreviewPageNumbers", () => {
    test("returns a capped page window", () => {
        expect(getPdfPreviewPageNumbers(2, 4)).toEqual([2, 3, 4]);
        expect(getPdfPreviewPageNumbers(2, 20)).toHaveLength(MAX_PDF_PREVIEW_PAGES);
        expect(getPdfPreviewPageNumbers(4, 2)).toEqual([]);
    });
});

describe("parsePageImageParam", () => {
    test("parses page image route params", () => {
        expect(parsePageImageParam("3.png")).toBe(3);
        expect(parsePageImageParam("0.png")).toBeNull();
        expect(parsePageImageParam("3")).toBeNull();
    });
});
