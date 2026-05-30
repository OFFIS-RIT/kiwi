import { describe, expect, test } from "bun:test";
import type { LoaderSourceChunk } from "@kiwi/graph";
import { loadSourceMap } from "../source-map";

describe("loadSourceMap", () => {
    test("loads stored loader source chunks", async () => {
        const chunks: LoaderSourceChunk[] = [
            {
                type: "text",
                text: "Alpha",
                startPage: 1,
                endPage: 1,
                startOffset: 0,
                endOffset: 5,
            },
        ];

        await expect(
            loadSourceMap("source-map.json", "bucket", {
                readFile: async () => ({ content: chunks }),
            })
        ).resolves.toEqual(chunks);
    });

    test("loads image chunks with source regions", async () => {
        const chunks: LoaderSourceChunk[] = [
            {
                type: "image",
                text: "Chart summary",
                imageId: "img-1",
                imageKey: "graphs/g-1/derived/file-1/images/img-1.png",
                startPage: 2,
                endPage: 2,
                startOffset: 10,
                endOffset: 58,
                regions: [
                    {
                        kind: "image",
                        page: 2,
                        width: 1200,
                        height: 1600,
                        rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }],
                    },
                ],
            },
        ];

        await expect(
            loadSourceMap("source-map.json", "bucket", {
                readFile: async () => ({ content: chunks }),
            })
        ).resolves.toEqual(chunks);
    });

    test("fails when a recorded source map is missing", async () => {
        await expect(
            loadSourceMap("missing-source-map.json", "bucket", {
                readFile: async () => null,
            })
        ).rejects.toThrow("Failed to load source map from missing-source-map.json");
    });

    test("fails when a recorded source map is malformed", async () => {
        await expect(
            loadSourceMap("bad-source-map.json", "bucket", {
                readFile: async () => ({ content: { chunks: [] } as never }),
            })
        ).rejects.toThrow("Failed to load source map from bad-source-map.json");
    });

    test("fails when a recorded source map contains invalid chunk entries", async () => {
        await expect(
            loadSourceMap("bad-source-map.json", "bucket", {
                readFile: async () => ({
                    content: [
                        {
                            type: "text",
                            text: "Alpha",
                            startPage: 1,
                            endPage: 1,
                            startOffset: 10,
                            endOffset: 5,
                        },
                    ],
                }),
            })
        ).rejects.toThrow("Failed to load source map from bad-source-map.json");
    });

    test("fails when a recorded source map contains inverted page spans", async () => {
        await expect(
            loadSourceMap("bad-source-map.json", "bucket", {
                readFile: async () => ({
                    content: [
                        {
                            type: "text",
                            text: "Alpha",
                            startPage: 3,
                            endPage: 2,
                            startOffset: 0,
                            endOffset: 5,
                        },
                    ],
                }),
            })
        ).rejects.toThrow("Failed to load source map from bad-source-map.json");
    });

    test("fails when a recorded source map contains malformed source regions", async () => {
        await expect(
            loadSourceMap("bad-source-map.json", "bucket", {
                readFile: async () => ({
                    content: [
                        {
                            type: "text",
                            text: "Alpha",
                            startPage: 1,
                            endPage: 1,
                            startOffset: 0,
                            endOffset: 5,
                            regions: [
                                {
                                    kind: "text",
                                    page: 0,
                                    width: 200,
                                    height: 100,
                                    rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                                },
                            ],
                        },
                    ],
                }),
            })
        ).rejects.toThrow("Failed to load source map from bad-source-map.json");
    });

    test("fails when a recorded source map contains source regions without rectangles", async () => {
        await expect(
            loadSourceMap("bad-source-map.json", "bucket", {
                readFile: async () => ({
                    content: [
                        {
                            type: "text",
                            text: "Alpha",
                            startPage: 1,
                            endPage: 1,
                            startOffset: 0,
                            endOffset: 5,
                            regions: [
                                {
                                    kind: "text",
                                    page: 1,
                                    width: 200,
                                    height: 100,
                                    rectangles: [],
                                },
                            ],
                        },
                    ],
                }),
            })
        ).rejects.toThrow("Failed to load source map from bad-source-map.json");
    });
});
