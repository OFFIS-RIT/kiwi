import { describe, expect, test } from "bun:test";
import type { BoundingBox, PageText, TableModelData, TablePage, TextChar, TextLine } from "../types";
import { extractWords, getLineText, tidyPageText } from "../text";
import { buildTableBlocksFromModels, reconstructTableCellText } from "../table";
import { repairPageTextLoneSurrogates } from "../unicode";

type TextCharOptions = {
    width?: number;
    height?: number;
    fontSize?: number;
    fontName?: string;
    y?: number;
    baseline?: number;
};

function textChar(char: string, x: number, sequenceIndex: number, options: TextCharOptions = {}): TextChar {
    const fontSize = options.fontSize ?? 12;
    const y = options.y ?? 100;
    return {
        char,
        bbox: { x, y, width: options.width ?? 5, height: options.height ?? 10 },
        fontSize,
        fontName: options.fontName ?? "Helvetica",
        baseline: options.baseline ?? 100,
        sequenceIndex,
    };
}

function bboxForChars(chars: TextChar[]): BoundingBox {
    const left = Math.min(...chars.map((char) => char.bbox.x));
    const right = Math.max(...chars.map((char) => char.bbox.x + char.bbox.width));
    const bottom = Math.min(...chars.map((char) => char.bbox.y));
    const top = Math.max(...chars.map((char) => char.bbox.y + char.bbox.height));

    return { x: left, y: bottom, width: right - left, height: top - bottom };
}

function textLine(chars: TextChar[]): TextLine {
    const text = chars.map((char) => char.char).join("");
    const bbox = bboxForChars(chars);

    return {
        text,
        bbox,
        baseline: chars[0]?.baseline ?? bbox.y,
        spans: [
            {
                text,
                bbox,
                fontSize: chars[0]?.fontSize ?? 12,
                fontName: chars[0]?.fontName ?? "Helvetica",
                chars,
            },
        ],
    };
}

function pageText(line: TextLine): PageText {
    return {
        pageIndex: 0,
        width: line.bbox.x + line.bbox.width + 20,
        height: line.bbox.y + line.bbox.height + 20,
        lines: [line],
        text: line.text,
    };
}

function rotatedTableModel(physicalRows = 8, physicalCols = 13): TableModelData {
    const cells: TableModelData["cells"] = [];
    const chars: TablePage["chars"] = [];
    let sequenceIndex = 0;

    for (let row = 0; row < physicalRows; row += 1) {
        for (let col = 0; col < physicalCols; col += 1) {
            const x0 = col * 20;
            const top = row * 20;
            cells.push({ x0, top, x1: x0 + 20, bottom: top + 20 });
            chars.push({
                text: "x",
                x0: x0 + 6,
                x1: x0 + 14,
                top: top + 6,
                bottom: top + 8,
                fontSize: 8,
                fontName: "Helvetica",
                baseline: top + 8,
                sequenceIndex,
            });
            sequenceIndex += 1;
        }
    }

    return {
        page: {
            bbox: { x0: 0, top: 0, x1: physicalCols * 20, bottom: physicalRows * 20 },
            words: [],
            chars,
            edges: [],
        },
        cells,
    };
}

function positionedChars(
    text: string,
    x: number,
    sequenceIndex: number,
    options: TextCharOptions & { gap?: number } = {}
): TextChar[] {
    let cursor = x;
    return Array.from(text, (char, index) => {
        const current = textChar(char, cursor, sequenceIndex + index, options);
        cursor += current.bbox.width + (options.gap ?? 0);
        return current;
    });
}

function splitFontWordChars(): TextChar[] {
    const firstRun = positionedChars("TEST", 10, 0, {
        width: 20,
        height: 38,
        fontSize: 38,
        fontName: "ExampleSans-SemiBold",
        y: 99.79,
        baseline: 130,
    });
    const secondRun = positionedChars("WORD", 90.5, 4, {
        width: 20,
        height: 38,
        fontSize: 38,
        fontName: "ExampleSans-Light",
        y: 93.1,
        baseline: 130,
    });

    return [...firstRun, ...secondRun];
}

function wideInlineGlyphWordChars(): TextChar[] {
    let cursor = 10;
    return Array.from("AXIOM", (char, index) => {
        const width = char === "O" ? 8.94 : 5;
        const current = textChar(char, cursor, index, {
            width,
            height: 8.34,
            fontSize: 10,
            baseline: 100,
        });
        cursor += width;
        return current;
    });
}

describe("PDF text reconstruction", () => {
    test("uses visual left-to-right order for normal horizontal text", () => {
        const right = Array.from("Right", (char, index) => textChar(char, 100 + index * 6, index));
        const left = Array.from("Left", (char, index) => textChar(char, 10 + index * 6, right.length + index));

        expect(getLineText(textLine([...right, ...left]))).toBe("Left Right");
    });

    test("keeps stream order for right-to-left placed text", () => {
        expect(getLineText(textLine([textChar("A", 30, 0), textChar("B", 20, 1), textChar("C", 10, 2)]))).toBe("ABC");
    });

    test("uses positional order for narrow side-by-side text emitted in interleaved stream order", () => {
        const chars = [
            textChar("A", 10, 0),
            textChar("1", 34, 1),
            textChar("B", 16, 2),
            textChar("2", 40, 3),
            textChar("C", 22, 4),
            textChar("3", 46, 5),
        ];

        expect(getLineText(textLine(chars))).toBe("ABC 123");
    });

    test("keeps wide glyphs from tight horizontal fonts in the same word", () => {
        const height = 11.17;
        const fontSize = 16.1;
        const chars = [
            textChar("D", 56.8, 0, { width: 11.62, height, fontSize }),
            textChar("u", 68.42, 1, { width: 9.82, height, fontSize }),
            textChar("m", 78.25, 2, { width: 14.31, height, fontSize }),
            textChar("m", 92.56, 3, { width: 14.31, height, fontSize }),
            textChar("y", 106.9, 4, { width: 8.95, height, fontSize }),
            textChar(" ", 115.9, 5, { width: 4.46, height, fontSize }),
            textChar("P", 120.3, 6, { width: 10.72, height, fontSize }),
            textChar("D", 131.02, 7, { width: 11.62, height, fontSize }),
            textChar("F", 142.65, 8, { width: 9.82, height, fontSize }),
            textChar(" ", 152.5, 9, { width: 4.46, height, fontSize }),
            textChar("f", 156.96, 10, { width: 5.36, height, fontSize }),
            textChar("i", 162.32, 11, { width: 4.46, height, fontSize }),
            textChar("l", 166.8, 12, { width: 4.46, height, fontSize }),
            textChar("e", 171.26, 13, { width: 8.95, height, fontSize }),
        ];

        expect(getLineText(textLine(chars))).toBe("Dummy PDF file");
    });

    test("keeps same-baseline font runs joined when glyph bboxes drift vertically", () => {
        const line = textLine(splitFontWordChars());

        expect(getLineText(line)).toBe("TESTWORD");
        expect(extractWords(pageText(line)).map((word) => word.text)).toEqual(["TESTWORD"]);
    });

    test("keeps compact small-font glyphs joined while splitting real word gaps", () => {
        const fontSize = 6;
        const first = positionedChars("ABC", 10, 0, { width: 3, height: 5, fontSize, gap: 0.8 });
        const second = positionedChars("DEF", 22, 3, { width: 3, height: 5, fontSize, gap: 0.8 });

        expect(getLineText(textLine([...first, ...second]))).toBe("ABC DEF");
    });

    test("joins split uppercase party tokens before inline connectors", () => {
        const chars = positionedChars("Gruppe DIE LI NKE./Piratenpartei", 10, 0);

        expect(getLineText(textLine(chars))).toBe("Gruppe DIE LINKE./Piratenpartei");
    });

    test("normalizes soft hyphen breaks and spaced name hyphens", () => {
        const chars = positionedChars("Interferome- ter Eilers -Dörfler", 10, 0);

        expect(getLineText(textLine(chars))).toBe("Interferometer Eilers-Dörfler");
    });

    test("splits same-baseline prose columns across a narrow gutter", () => {
        const left = positionedChars("Left column paragraph text", 56, 0, {
            width: 5,
            height: 10,
            fontSize: 10,
        });
        const right = positionedChars("Right column paragraph text", 205, left.length, {
            width: 5,
            height: 10,
            fontSize: 10,
        });
        const page = tidyPageText(pageText(textLine([...left, ...right])));

        expect(page.lines.map(getLineText)).toEqual(["Left column paragraph text", "Right column paragraph text"]);
    });

    test("uses vertical glyph gaps as word breaks", () => {
        const chars: TextChar[] = [];
        let cursor = 120;
        let sequenceIndex = 0;
        for (const char of "BodensaurerBuchenwalddes") {
            if (char === "B" && chars.length > 0) {
                cursor -= 1.25;
            }
            if (char === "d" && chars.at(-1)?.char === "d") {
                cursor -= 1.25;
            }

            const height = 2.5;
            cursor -= height;
            chars.push(
                textChar(char, 20, sequenceIndex, {
                    width: 4.2,
                    height,
                    fontSize: 5,
                    y: cursor,
                    baseline: cursor + height,
                })
            );
            sequenceIndex += 1;
        }

        expect(getLineText(textLine(chars))).toBe("Bodensaurer Buchenwald des");
    });

    test("reconstructs two-font table cell text without splitting same-baseline glyph runs", () => {
        const logo = splitFontWordChars();
        const description = positionedChars("Interferometer", 210, logo.length, {
            width: 6,
            height: 10,
            fontSize: 12,
            y: 96,
            baseline: 130,
        });

        expect(reconstructTableCellText([...logo, ...description])).toBe("TESTWORD Interferometer");
    });

    test("reconstructs wide inline glyphs as horizontal table text", () => {
        const word = wideInlineGlyphWordChars();
        const description = positionedChars("Device", 60, word.length, {
            width: 5,
            height: 8.34,
            fontSize: 10,
            baseline: 100,
        });

        expect(reconstructTableCellText([...word, ...description])).toBe("AXIOM Device");
    });

    test("reconstructs stacked table header glyphs as vertical words", () => {
        const chars = Array.from("PHASE", (char, index) =>
            textChar(char, 10, index, {
                width: 5,
                height: 8,
                fontSize: 10,
                y: 120 - index * 10,
                baseline: 128 - index * 10,
            })
        );

        expect(reconstructTableCellText(chars)).toBe("PHASE");
    });

    test("keeps square leading glyphs with their vertical table word", () => {
        const chars = Array.from("Wide", (char, index) =>
            textChar(char, 10, index, {
                width: 4.15,
                height: char === "W" ? 4.37 : 2.45,
                fontSize: 4.15,
                y: 120 + index * 3,
                baseline: 120 + index * 3,
            })
        );

        expect(reconstructTableCellText(chars)).toBe("Wide");
    });

    test("keeps right-to-left emitted horizontal table cells in stream order", () => {
        const chars = Array.from("size (ha)", (char, index) =>
            textChar(char, 70 - index * 5, index, {
                width: 5,
                height: 8,
                fontSize: 8,
                baseline: 108,
            })
        );

        expect(reconstructTableCellText(chars)).toBe("size (ha)");
    });

    test("expands packed printable ASCII pairs before text consumers see CJK-like artifacts", () => {
        const packedAsciiPair = String.fromCharCode(0x4142);
        const line = textLine([textChar(packedAsciiPair, 10, 0)]);
        const repaired = repairPageTextLoneSurrogates(pageText(line));

        expect(repaired.text).toBe("AB");
        expect(repaired.lines[0]?.text).toBe("AB");
        expect(repaired.lines[0]?.spans[0]?.text).toBe("AB");
        expect(repaired.lines[0]?.spans[0]?.chars.map((char) => char.char)).toEqual(["AB"]);
        expect(repaired.text).not.toContain(packedAsciiPair);
    });

    test("expands packed printable Latin-1 pairs before text consumers see CJK-like artifacts", () => {
        const packedLatin1Pair = String.fromCharCode(0x46f6);
        const line = textLine([textChar(packedLatin1Pair, 10, 0)]);
        const repaired = repairPageTextLoneSurrogates(pageText(line));

        expect(repaired.text).toBe("Fö");
        expect(repaired.lines[0]?.text).toBe("Fö");
        expect(repaired.lines[0]?.spans[0]?.text).toBe("Fö");
        expect(repaired.lines[0]?.spans[0]?.chars.map((char) => char.char)).toEqual(["Fö"]);
        expect(repaired.text).not.toContain(packedLatin1Pair);
    });

    test("expands packed printable Windows-1252 pairs before text consumers see CJK-like artifacts", () => {
        const packedWindows1252Pair = String.fromCharCode(0x6793);
        const line = textLine([textChar(packedWindows1252Pair, 10, 0)]);
        const repaired = repairPageTextLoneSurrogates(pageText(line));

        expect(repaired.text).toBe("g“");
        expect(repaired.lines[0]?.text).toBe("g“");
        expect(repaired.lines[0]?.spans[0]?.text).toBe("g“");
        expect(repaired.lines[0]?.spans[0]?.chars.map((char) => char.char)).toEqual(["g“"]);
        expect(repaired.text).not.toContain(packedWindows1252Pair);
    });

    test("repairs lone surrogates without changing valid pairs", () => {
        const emoji = "😀";
        const line = textLine([textChar("\udf65", 10, 0), textChar(emoji, 20, 1)]);
        const repaired = repairPageTextLoneSurrogates({ ...pageText(line), text: `A\udf65${emoji}` });

        expect(repaired.text).toBe(`A�${emoji}`);
        expect(repaired.lines[0]?.text).toBe(`�${emoji}`);
        expect(repaired.lines[0]?.spans[0]?.text).toBe(`�${emoji}`);
        expect(repaired.lines[0]?.spans[0]?.chars.map((char) => char.char)).toEqual(["�", emoji]);
    });

    test("transposes rotated grid tables before enforcing the column limit", () => {
        const model = rotatedTableModel();
        const [table] = buildTableBlocksFromModels(model.page, [model], "lines");

        expect(table?.rowCount).toBe(13);
        expect(table?.colCount).toBe(8);
        expect(table?.markdown).toContain("| x | x | x | x | x | x | x | x |");
    });
});
