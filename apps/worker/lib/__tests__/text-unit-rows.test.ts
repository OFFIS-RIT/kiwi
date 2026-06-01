import { describe, expect, test } from "bun:test";
import type { Unit } from "@kiwi/graph";
import { toTextUnitRows } from "../text-unit-rows";

describe("toTextUnitRows", () => {
    test("keeps page spans in the text unit persistence payload", () => {
        const units: Unit[] = [
            {
                id: "unit-1",
                fileId: "file-1",
                content: "Alpha",
                startPage: 2,
                endPage: 3,
                chunks: [{ id: 1, type: "text", text: "Alpha", startPage: 2, endPage: 3 }],
            },
            {
                id: "unit-2",
                fileId: "file-1",
                content: "Beta",
                startPage: null,
                endPage: null,
                chunks: [{ id: 1, type: "text", text: "Beta", startPage: null, endPage: null }],
            },
        ];

        expect(toTextUnitRows(units)).toEqual([
            {
                id: "unit-1",
                fileId: "file-1",
                text: "Alpha",
                startPage: 2,
                endPage: 3,
                chunks: [{ id: 1, type: "text", text: "Alpha", startPage: 2, endPage: 3 }],
            },
            {
                id: "unit-2",
                fileId: "file-1",
                text: "Beta",
                startPage: null,
                endPage: null,
                chunks: [{ id: 1, type: "text", text: "Beta", startPage: null, endPage: null }],
            },
        ]);
    });
});
