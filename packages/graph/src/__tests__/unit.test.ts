import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { createUnits, createUnitsFromText } from "../unit.ts";
import type { GraphChunker, GraphFile, LoaderSourceChunk } from "../index.ts";
import { resolveTextChunkSpans } from "@kiwi/loaders/chunker/span";

function fixedChunker(chunks: string[]): GraphChunker {
    return {
        getChunks: async () => chunks,
        getChunkSpans: async (input) => resolveTextChunkSpans(input, chunks),
    };
}

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
            chunker: fixedChunker([":::PAGE-1:::\n\nAlpha", "Beta\n\n:::PAGE-2:::\n\nGamma", ":::PAGE-3:::", "Delta"]),
        };

        const units = await Effect.runPromise(createUnits(file));

        expect(
            units.map(({ fileId, content, startPage, endPage, chunks }) => ({
                fileId,
                content,
                startPage,
                endPage,
                chunks,
            }))
        ).toEqual([
            {
                fileId: "file-1",
                content: "Alpha",
                startPage: 1,
                endPage: 1,
                chunks: [{ id: 1, type: "text", text: "Alpha", startPage: 1, endPage: 1 }],
            },
            {
                fileId: "file-1",
                content: "Beta\n\nGamma",
                startPage: 1,
                endPage: 2,
                chunks: [{ id: 1, type: "text", text: "Beta\n\nGamma", startPage: 1, endPage: 2 }],
            },
            {
                fileId: "file-1",
                content: "Delta",
                startPage: 3,
                endPage: 3,
                chunks: [{ id: 1, type: "text", text: "Delta", startPage: 3, endPage: 3 }],
            },
        ]);
    });

    test("assigns loader source chunks by raw offset overlap and renumbers them per unit", async () => {
        const text = [
            ":::PAGE-1:::",
            "",
            "Alpha sentence one.",
            "Beta sentence two.",
            "",
            ":::PAGE-2:::",
            "",
            "Gamma sentence three.",
        ].join("\n");
        const alphaStart = text.indexOf("Alpha sentence one.");
        const betaStart = text.indexOf("Beta sentence two.");
        const gammaStart = text.indexOf("Gamma sentence three.");
        const loaderSourceChunks: LoaderSourceChunk[] = [
            {
                type: "text",
                text: "Alpha sentence one.",
                startPage: 1,
                endPage: 1,
                startOffset: alphaStart,
                endOffset: alphaStart + "Alpha sentence one.".length,
                regions: [
                    {
                        kind: "text",
                        page: 1,
                        width: 100,
                        height: 200,
                        rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                    },
                ],
            },
            {
                type: "text",
                text: "Beta sentence two.",
                startPage: 1,
                endPage: 1,
                startOffset: betaStart,
                endOffset: betaStart + "Beta sentence two.".length,
            },
            {
                type: "text",
                text: "Gamma sentence three.",
                startPage: 2,
                endPage: 2,
                startOffset: gammaStart,
                endOffset: gammaStart + "Gamma sentence three.".length,
            },
        ];

        const units = await Effect.runPromise(createUnitsFromText({
            fileId: "file-1",
            fileType: "pdf",
            text,
            chunker: fixedChunker([
                ":::PAGE-1::: Alpha sentence one. Beta sentence two.",
                ":::PAGE-2:::\n\nGamma sentence three.",
            ]),
            loaderSourceChunks,
        }));

        expect(units.map((unit) => unit.chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })))).toEqual([
            [
                { id: 1, text: "Alpha sentence one." },
                { id: 2, text: "Beta sentence two." },
            ],
            [{ id: 1, text: "Gamma sentence three." }],
        ]);
        expect(units[0]?.chunks[0]).toMatchObject({
            id: 1,
            regions: [
                {
                    kind: "text",
                    page: 1,
                },
            ],
        });
    });

    test("falls back to text chunks when raw chunk offsets cannot be proven", async () => {
        const text = "Alpha sentence one.";
        const units = await Effect.runPromise(createUnitsFromText({
            fileId: "file-1",
            fileType: "pdf",
            text,
            chunker: fixedChunker(["Rewritten sentence that is not in the source text."]),
            loaderSourceChunks: [
                {
                    type: "text",
                    text,
                    startPage: 1,
                    endPage: 1,
                    startOffset: 0,
                    endOffset: text.length,
                    regions: [
                        {
                            kind: "text",
                            page: 1,
                            width: 100,
                            height: 200,
                            rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                        },
                    ],
                },
            ],
        }));

        expect(units).toHaveLength(1);
        expect(units[0]?.chunks).toEqual([
            {
                id: 1,
                type: "text",
                text: "Rewritten sentence that is not in the source text.",
                startPage: null,
                endPage: null,
            },
        ]);
    });

    test("does not attach loader chunks to zero-length unmatched spans after matched content", async () => {
        const text = "Alpha sentence one. Beta sentence two.";
        const units = await Effect.runPromise(createUnitsFromText({
            fileId: "file-1",
            fileType: "pdf",
            text,
            chunker: fixedChunker(["Alpha sentence one.", "Rewritten sentence that is not in the source text."]),
            loaderSourceChunks: [
                {
                    type: "text",
                    text,
                    startPage: 1,
                    endPage: 1,
                    startOffset: 0,
                    endOffset: text.length,
                    regions: [
                        {
                            kind: "text",
                            page: 1,
                            width: 100,
                            height: 200,
                            rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                        },
                    ],
                },
            ],
        }));

        expect(units).toHaveLength(2);
        expect(units[0]?.chunks).toEqual([
            {
                id: 1,
                type: "text",
                text,
                startPage: 1,
                endPage: 1,
                regions: [
                    {
                        kind: "text",
                        page: 1,
                        width: 100,
                        height: 200,
                        rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                    },
                ],
            },
        ]);
        expect(units[1]?.chunks).toEqual([
            {
                id: 1,
                type: "text",
                text: "Rewritten sentence that is not in the source text.",
                startPage: null,
                endPage: null,
            },
        ]);
    });

    test("keeps fence-only chunks from desynchronizing loader source chunk alignment", async () => {
        const text = [":::PAGE-1:::", "", "Alpha text.", "", ":::PAGE-2:::", "", "Beta text."].join("\n");
        const alphaStart = text.indexOf("Alpha text.");
        const betaStart = text.indexOf("Beta text.");

        const units = await Effect.runPromise(createUnitsFromText({
            fileId: "file-1",
            fileType: "pdf",
            text,
            chunker: fixedChunker([":::PAGE-1:::", "Alpha text.", ":::PAGE-2:::", "Beta text."]),
            loaderSourceChunks: [
                {
                    type: "text",
                    text: "Alpha text.",
                    startPage: 1,
                    endPage: 1,
                    startOffset: alphaStart,
                    endOffset: alphaStart + "Alpha text.".length,
                    regions: [
                        {
                            kind: "text",
                            page: 1,
                            width: 100,
                            height: 200,
                            rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                        },
                    ],
                },
                {
                    type: "text",
                    text: "Beta text.",
                    startPage: 2,
                    endPage: 2,
                    startOffset: betaStart,
                    endOffset: betaStart + "Beta text.".length,
                    regions: [
                        {
                            kind: "text",
                            page: 2,
                            width: 100,
                            height: 200,
                            rectangles: [{ left: 0.2, top: 0.3, width: 0.4, height: 0.05 }],
                        },
                    ],
                },
            ],
        }));

        expect(
            units.map((unit) => ({
                content: unit.content,
                startPage: unit.startPage,
                endPage: unit.endPage,
                chunks: unit.chunks.map((chunk) => ({
                    id: chunk.id,
                    text: chunk.text,
                    startPage: chunk.startPage,
                    endPage: chunk.endPage,
                })),
            }))
        ).toEqual([
            {
                content: "Alpha text.",
                startPage: 1,
                endPage: 1,
                chunks: [{ id: 1, text: "Alpha text.", startPage: 1, endPage: 1 }],
            },
            {
                content: "Beta text.",
                startPage: 2,
                endPage: 2,
                chunks: [{ id: 1, text: "Beta text.", startPage: 2, endPage: 2 }],
            },
        ]);
    });
});
