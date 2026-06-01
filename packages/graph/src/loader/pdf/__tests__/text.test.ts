import { describe, expect, test } from "bun:test";
import type { TextChar, TextLine } from "../types";
import { getLineText } from "../text";

function textChar(char: string, x: number, sequenceIndex: number): TextChar {
    return {
        char,
        bbox: { x, y: 100, width: 5, height: 10 },
        fontSize: 12,
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

});
