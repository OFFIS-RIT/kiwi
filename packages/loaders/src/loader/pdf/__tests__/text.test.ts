import { describe, expect, test } from "bun:test";
import type { BoundingBox, PageText, TextChar, TextLine } from "../types";
import { extractWords, getLineText } from "../text";
import { reconstructTableCellText } from "../table";

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
});
