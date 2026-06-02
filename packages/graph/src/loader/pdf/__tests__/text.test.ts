import { describe, expect, test } from "bun:test";
import type { TextChar, TextLine } from "../types";
import { getLineText } from "../text";

function textChar(
    char: string,
    x: number,
    sequenceIndex: number,
    options: { width?: number; height?: number; fontSize?: number } = {}
): TextChar {
    const fontSize = options.fontSize ?? 12;
    return {
        char,
        bbox: { x, y: 100, width: options.width ?? 5, height: options.height ?? 10 },
        fontSize,
        fontName: "Helvetica",
        baseline: 100,
        sequenceIndex,
    };
}

function textLine(chars: TextChar[]): TextLine {
    return {
        text: chars.map((char) => char.char).join(""),
        bbox: { x: 0, y: 100, width: 140, height: 10 },
        baseline: 100,
        spans: [
            {
                text: chars.map((char) => char.char).join(""),
                bbox: { x: 0, y: 100, width: 140, height: 10 },
                fontSize: 12,
                fontName: "Helvetica",
                chars,
            },
        ],
    };
}

describe("PDF text reconstruction", () => {
    test("uses visual left-to-right order for normal horizontal text", () => {
        const right = Array.from("Right", (char, index) => textChar(char, 100 + index * 6, index));
        const left = Array.from("Left", (char, index) => textChar(char, 10 + index * 6, right.length + index));

        expect(getLineText(textLine([...right, ...left]))).toBe("Left Right");
    });

    test("keeps stream order for right-to-left placed text", () => {
        expect(getLineText(textLine([textChar("A", 30, 0), textChar("B", 20, 1), textChar("C", 10, 2)]))).toBe(
            "ABC"
        );
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
});
