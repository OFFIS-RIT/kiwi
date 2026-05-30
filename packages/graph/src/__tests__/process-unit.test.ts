import { beforeEach, describe, expect, mock, test } from "bun:test";

const extractionOutput = {
    entities: [
        {
            name: "ACME",
            type: "ORGANIZATION",
            description: "Acme is an organization.",
            sourceChunkIds: [2, 999, 1, 2],
        },
        {
            name: "ALICE",
            type: "PERSON",
            description: "Alice is a person.",
            sourceChunkIds: [2, 999, 1, 2],
        },
    ],
    relationships: [
        {
            sourceEntity: "ACME",
            targetEntity: "ALICE",
            description: "Acme hired Alice.",
            strength: 0.8,
            sourceChunkIds: [2, 999, 1, 2],
        },
    ],
};

const generateTextMock = mock(async () => {
    return {
        output: extractionOutput,
    };
});

mock.module("ai", () => ({
    generateText: generateTextMock,
    Output: {
        object: (value: unknown) => value,
    },
}));

describe("processUnit", () => {
    beforeEach(() => {
        generateTextMock.mockClear();
    });

    test("extracts from clean text and attaches attributed source chunk ids", async () => {
        const { processUnit } = await import("../unit.ts");
        const graph = await processUnit(
            {
                id: "unit-1",
                fileId: "file-1",
                content: "Acme hired Alice.",
                startPage: null,
                endPage: null,
                chunks: [
                    {
                        id: 1,
                        type: "text",
                        text: [
                            "Acme hired Alice.",
                            "",
                            "| Metric | Value |",
                            "| --- | --- |",
                            "| Rent | 1200 EUR |",
                        ].join("\n"),
                        startPage: null,
                        endPage: null,
                    },
                    {
                        id: 2,
                        type: "image",
                        text: "Alice works at Acme.",
                        imageId: "img-1",
                        imageKey: null,
                        startPage: null,
                        endPage: null,
                    },
                ],
            },
            {} as never,
            "document.txt"
        );

        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock.mock.calls[0]?.[0].prompt).toBe(
            [
                ":::SOURCE-CHUNK-1 type=text:::",
                "Acme hired Alice.",
                "",
                "| Metric | Value |",
                "| --- | --- |",
                "| Rent | 1200 EUR |",
                ":::END-SOURCE-CHUNK-1:::",
                "",
                ":::SOURCE-CHUNK-2 type=image:::",
                "Alice works at Acme.",
                ":::END-SOURCE-CHUNK-2:::",
            ].join("\n")
        );
        expect(graph.entities).toHaveLength(2);
        expect(graph.entities[0]?.sources[0]?.sourceChunkIds).toEqual([2, 1]);
        expect(graph.relationships[0]?.sources[0]?.sourceChunkIds).toEqual([2, 1]);
    });

    test("uses the single available chunk when no attribution pass is needed", async () => {
        const { processUnit } = await import("../unit.ts");
        const graph = await processUnit(
            {
                id: "unit-1",
                fileId: "file-1",
                content: "Acme hired Alice.",
                startPage: null,
                endPage: null,
                chunks: [{ id: 1, type: "text", text: "Acme hired Alice.", startPage: null, endPage: null }],
            },
            {} as never,
            "document.txt"
        );

        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock.mock.calls[0]?.[0].prompt).toBe("Acme hired Alice.");
        expect(graph.entities[0]?.sources[0]?.sourceChunkIds).toEqual([1]);
        expect(graph.relationships[0]?.sources[0]?.sourceChunkIds).toEqual([1]);
    });

    test("falls back to bounded source chunk ids when attribution is omitted", async () => {
        const { normalizeSourceChunkIds } = await import("../unit.ts");

        expect(
            normalizeSourceChunkIds([], {
                chunks: [
                    { id: 1, type: "text", text: "Alpha", startPage: null, endPage: null },
                    { id: 2, type: "text", text: "Beta", startPage: null, endPage: null },
                ],
            })
        ).toEqual([1, 2]);
    });

    test("caps fallback attribution to the maximum source chunk count", async () => {
        const { normalizeSourceChunkIds } = await import("../unit.ts");
        const chunks = Array.from({ length: 12 }, (_, index) => ({
            id: index + 1,
            type: "text" as const,
            text: `Chunk ${index + 1}`,
            startPage: null,
            endPage: null,
        }));

        expect(normalizeSourceChunkIds([], { chunks })).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(normalizeSourceChunkIds([9, 1, 9, 2, 3, 4, 5, 6, 7, 8], { chunks })).toEqual([
            9, 1, 2, 3, 4, 5, 6, 7,
        ]);
    });
});
