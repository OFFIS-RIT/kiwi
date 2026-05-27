import { describe, expect, test } from "bun:test";
import { createUnits } from "../unit.ts";
import type { GraphFile } from "../index.ts";

describe("createUnits", () => {
    test("stores page-aware units without internal page fences", async () => {
        const file: GraphFile = {
            id: "file-1",
            key: "source.txt",
            filename: "source.txt",
            filetype: "text",
            loader: {
                getText: async () => "ignored",
            },
            chunker: {
                getChunks: async () => [
                    ":::PAGE-1:::\n\nAlpha",
                    "Beta\n\n:::PAGE-2:::\n\nGamma",
                    ":::PAGE-3:::",
                    "Delta",
                ],
            },
        };

        const units = await createUnits(file);

        expect(
            units.map(({ fileId, content, startPage, endPage }) => ({ fileId, content, startPage, endPage }))
        ).toEqual([
            {
                fileId: "file-1",
                content: "Alpha",
                startPage: 1,
                endPage: 1,
            },
            {
                fileId: "file-1",
                content: "Beta\n\nGamma",
                startPage: 1,
                endPage: 2,
            },
            {
                fileId: "file-1",
                content: "Delta",
                startPage: 3,
                endPage: 3,
            },
        ]);
    });
});
