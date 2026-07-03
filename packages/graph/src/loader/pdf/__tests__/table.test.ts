import { describe, expect, test } from "bun:test";
import { detectTables, extractWords, looksLikeRotatedDrawnTableLayout, mergeAdjacentTableColumns } from "../table";
import type { BoundingBox, Edge, PageText, TextChar, TextLine } from "../types";

const PAGE_WIDTH = 260;
const PAGE_HEIGHT = 760;

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

function horizontalRtlLine(text: string, rightX: number, y: number, sequenceStart: number): TextLine {
    const chars = Array.from(text, (char, index): TextChar => {
        const x = rightX - index * 5;
        return {
            char,
            bbox: { x, y, width: 5, height: 8 },
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

function pageText(lines: TextLine[]): PageText {
    return {
        pageIndex: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        text: lines.map((line) => line.text).join("\n"),
        lines,
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

function rotatedDrawnTableFixture(): { pageText: PageText; edges: Edge[] } {
    const xs = [40, 110, 180, 250];
    const ys = [40, 90, 140, 190];
    const cellTexts = [
        ["A1", "B1", "C1"],
        ["A2", "B2", "C2"],
        ["A3", "B3", "C3"],
    ];
    const lines: TextLine[] = [];
    let sequence = 0;

    for (let row = 0; row < cellTexts.length; row += 1) {
        for (let column = 0; column < cellTexts[row]!.length; column += 1) {
            lines.push(verticalLine(cellTexts[row]![column]!, xs[column]! + 16, ys[row]! + 12, sequence));
            sequence += cellTexts[row]![column]!.length;
        }
    }

    return { pageText: pageText(lines), edges: rectGridEdges(xs, ys) };
}

function rotatedKeyValueTableFixture(): { pageText: PageText; edges: Edge[] } {
    const xs = [40, 110, 240];
    const ys = [40, 110, 150, 190, 330, 400, 560, 610, 660, 710];
    const lines: TextLine[] = [];
    let sequence = 0;
    const addVertical = (text: string, x: number, y: number) => {
        lines.push(verticalLine(text, x, y, sequence));
        sequence += text.length;
    };

    addVertical("Field-", 52, 56);
    addVertical("No./", 64, 56);
    addVertical("Label", 76, 56);
    addVertical("Unit-", 52, 116);
    lines.push(horizontalRtlLine("size (ha)", 94, 164, sequence));
    sequence += "size (ha)".length;
    addVertical("Purpose", 52, 212);
    addVertical("• first item", 142, 212);
    addVertical("continued", 154, 212);
    addVertical("• second item", 166, 212);
    addVertical("Impacts-", 52, 352);
    addVertical("Risks", 64, 352);
    addVertical("Plan-, Build- und", 52, 420);
    addVertical("Review-Tasks", 64, 420);
    addVertical("Program", 52, 568);
    addVertical("Special", 52, 616);
    addVertical("Need", 64, 616);
    addVertical("Reason", 52, 668);

    return { pageText: pageText(lines), edges: rectGridEdges(xs, ys) };
}

function denseMixedDrawnGridTableFixture(): { pageText: PageText; edges: Edge[] } {
    const xs = [20, 80, 140, 200, 250];
    const ys = [40, 100, 160, 220, 280, 340, 400];
    const lines: TextLine[] = [];
    let sequence = 0;

    for (let row = 0; row < ys.length - 1; row += 1) {
        for (let column = 0; column < xs.length - 1; column += 1) {
            const vertical = row < 2 || (row === 2 && column < 2);
            const text = vertical ? `V${row + 1}${column + 1}A` : `H${row + 1}${column + 1}B`;
            lines.push(
                vertical
                    ? verticalLine(text, xs[column]! + 18, ys[row]! + 10, sequence)
                    : horizontalLine(text, xs[column]! + 4, ys[row]! + 24, sequence)
            );
            sequence += text.length;
        }
    }

    return { pageText: pageText(lines), edges: rectGridEdges(xs, ys) };
}

describe("PDF table detection", () => {
    test("uses non-strict drawn edges for rotated table pages in strict mode", () => {
        const fixture = rotatedDrawnTableFixture();
        const words = extractWords(fixture.pageText);

        expect(looksLikeRotatedDrawnTableLayout(fixture.pageText.lines, fixture.edges)).toBe(true);
        const tables = detectTables(fixture.pageText, words, fixture.pageText.lines, fixture.edges, "lines_strict");

        expect(tables).toHaveLength(1);
        expect(tables[0]?.rowCount).toBe(3);
        expect(tables[0]?.colCount).toBe(3);
        expect(tables[0]?.markdown).toContain("| A3 | B3 | C3 |");
    });

    test("keeps sparse rotated key-value grid rows as a two-column table", () => {
        const fixture = rotatedKeyValueTableFixture();
        const words = extractWords(fixture.pageText);
        const tables = detectTables(fixture.pageText, words, fixture.pageText.lines, fixture.edges, "lines_strict");

        expect(tables).toHaveLength(1);
        expect(tables[0]?.rowCount).toBe(9);
        expect(tables[0]?.colCount).toBe(2);
        expect(tables[0]?.markdown).toContain("| Reason |  |");
        expect(tables[0]?.markdown).toContain("| Plan-, Build- und Review-Tasks |  |");
        expect(tables[0]?.markdown).toContain("| Purpose | • first item continued • second item |");
        expect(tables[0]?.markdown).toContain("| Unitsize (ha) |  |");
        expect(tables[0]?.markdown).toContain("| Field-No./ Label |  |");
    });

    test("uses loose drawn-grid lines in strict mode for dense mixed-orientation tables", () => {
        const fixture = denseMixedDrawnGridTableFixture();
        const words = extractWords(fixture.pageText);
        const tables = detectTables(fixture.pageText, words, fixture.pageText.lines, fixture.edges, "lines_strict");

        expect(tables).toHaveLength(1);
        expect(tables[0]?.rowCount).toBe(6);
        expect(tables[0]?.colCount).toBe(4);
        expect(tables[0]?.markdown).toContain("| V11A | V12A | V13A | V14A |");
        expect(tables[0]?.markdown).toContain("| V31A | V32A | H33B | H34B |");
        expect(tables[0]?.markdown).toContain("| H61B | H62B | H63B | H64B |");
    });

    test("cleans hyphenated words after merging sparse adjacent columns", () => {
        const rows = mergeAdjacentTableColumns([["data-", "set"]], 0);

        expect(rows[0]?.[0]).toBe("dataset");
    });
});
