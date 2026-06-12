import { describe, expect, test } from "bun:test";
import { selectSourceChunks, toSourceReferenceRecord, type SourceReferenceRow } from "../source-reference-record";

function sourceRow(overrides: Partial<SourceReferenceRow> = {}): SourceReferenceRow {
    return {
        source_id: "source-1",
        source_description: "Source description",
        source_chunk_ids: [1],
        id: "unit-1",
        project_file_id: "file-1",
        text: "Full unit text",
        chunks: [{ id: 1, type: "text", text: "Alpha chunk", startPage: null, endPage: null }],
        start_page: null,
        end_page: null,
        file_name: "document.txt",
        file_type: "text",
        mime_type: "text/plain",
        file_key: "source.txt",
        created_at: null,
        updated_at: null,
        ...overrides,
    };
}

describe("toSourceReferenceRecord", () => {
    test("returns selected text chunks without full text unit content", async () => {
        const reference = await toSourceReferenceRecord("graph-1", sourceRow());

        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 1, text: "Alpha chunk" }]);
        expect(reference.pdf_regions).toEqual([]);
        expect(reference.unit).not.toHaveProperty("text");
    });

    test("falls back to full unit text for legacy non-PDF sources without stored chunks", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                source_chunk_ids: [],
                chunks: [],
                text: "Legacy unit text",
            })
        );

        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 1, text: "Legacy unit text" }]);
        expect(reference.pdf_regions).toEqual([]);
    });

    test("falls back to PDF page previews for legacy PDF sources without stored chunks", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                start_page: 2,
                end_page: 3,
                source_chunk_ids: [],
                chunks: [],
            })
        );

        expect(reference.chunks).toEqual([]);
        expect(reference.pdf_regions).toEqual([
            {
                kind: "page",
                chunk_id: 2,
                page: 2,
                width: 1200,
                height: 1600,
                image_path: "/graphs/graph-1/units/unit-1/pages/2.png",
                crop: { left: 0, top: 0, width: 1, height: 1 },
                rectangles: [{ left: 0, top: 0, width: 1, height: 1 }],
            },
            {
                kind: "page",
                chunk_id: 3,
                page: 3,
                width: 1200,
                height: 1600,
                image_path: "/graphs/graph-1/units/unit-1/pages/3.png",
                crop: { left: 0, top: 0, width: 1, height: 1 },
                rectangles: [{ left: 0, top: 0, width: 1, height: 1 }],
            },
        ]);
    });

    test("deduplicates selected chunk ids and ignores invalid ids", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                source_chunk_ids: [1, 999, 1, 2],
                chunks: [
                    { id: 1, type: "text", text: "Alpha chunk", startPage: null, endPage: null },
                    { id: 2, type: "text", text: "Beta chunk", startPage: null, endPage: null },
                ],
            })
        );

        expect(reference.chunks).toEqual([
            { type: "text", chunk_id: 1, text: "Alpha chunk" },
            { type: "text", chunk_id: 2, text: "Beta chunk" },
        ]);
    });

    test("uses the only stored chunk when chunk ids are missing", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                source_chunk_ids: [],
                text: "Full unit text that should not be returned.",
                chunks: [{ id: 1, type: "text", text: "Alpha chunk", startPage: null, endPage: null }],
            })
        );

        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 1, text: "Alpha chunk" }]);
    });

    test("falls back to broad legacy text instead of guessing among multiple chunks", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                source_chunk_ids: [],
                text: "Full unit text.",
                chunks: [
                    { id: 1, type: "text", text: "Alpha chunk", startPage: null, endPage: null },
                    { id: 2, type: "text", text: "Beta chunk", startPage: null, endPage: null },
                ],
            })
        );

        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 1, text: "Full unit text." }]);
    });

    test("falls back to legacy text when stored source chunks are malformed", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                source_chunk_ids: [1],
                text: "Legacy unit text",
                chunks: [null, { id: "1", type: "text", text: "Bad chunk" }] as never,
            })
        );

        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 1, text: "Legacy unit text" }]);
        expect(reference.pdf_regions).toEqual([]);
    });

    test("falls back to legacy text when stored source chunk page spans are inverted", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                source_chunk_ids: [1],
                text: "Legacy unit text",
                chunks: [{ id: 1, type: "text", text: "Bad span chunk", startPage: 3, endPage: 2 }],
            })
        );

        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 1, text: "Legacy unit text" }]);
        expect(reference.pdf_regions).toEqual([]);
    });

    test("returns stored PDF crop regions and text fallback for chunks without stored regions", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                file_key: "source.pdf",
                start_page: 3,
                end_page: 4,
                source_chunk_ids: [1, 2],
                chunks: [
                    {
                        id: 1,
                        type: "text",
                        text: "Alpha chunk",
                        startPage: 3,
                        endPage: 3,
                        regions: [
                            {
                                kind: "text",
                                page: 3,
                                width: 200,
                                height: 100,
                                rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                            },
                        ],
                    },
                    { id: 2, type: "text", text: "Beta chunk", startPage: 3, endPage: 3 },
                ],
            })
        );

        expect(reference.pdf_regions).toHaveLength(1);
        expect(reference.pdf_regions[0]).toMatchObject({
            kind: "text",
            chunk_id: 1,
            page: 3,
            width: 200,
            height: 100,
            image_path: "/graphs/graph-1/units/unit-1/pages/3.png",
            rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
        });
        expect(reference.pdf_regions[0]?.crop.left).toBeCloseTo(0.06);
        expect(reference.pdf_regions[0]?.crop.top).toBeCloseTo(0.14);
        expect(reference.pdf_regions[0]?.crop.width).toBeCloseTo(0.38);
        expect(reference.pdf_regions[0]?.crop.height).toBeCloseTo(0.16);
        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 2, text: "Beta chunk" }]);
    });

    test("keeps stored PDF regions without source PDF loading", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                file_key: "source.pdf",
                start_page: 2,
                end_page: 2,
                source_chunk_ids: [1, 2],
                chunks: [
                    {
                        id: 1,
                        type: "text",
                        text: "Alpha chunk",
                        startPage: 2,
                        endPage: 2,
                        regions: [
                            {
                                kind: "text",
                                page: 2,
                                width: 200,
                                height: 100,
                                rectangles: [{ left: 0.2, top: 0.3, width: 0.1, height: 0.05 }],
                            },
                        ],
                    },
                    { id: 2, type: "text", text: "Beta chunk", startPage: 2, endPage: 2 },
                ],
            })
        );

        expect(reference.pdf_regions).toHaveLength(1);
        expect(reference.pdf_regions[0]).toMatchObject({
            kind: "text",
            chunk_id: 1,
            page: 2,
        });
        expect(reference.chunks).toEqual([{ type: "text", chunk_id: 2, text: "Beta chunk" }]);
    });

    test("uses stored PDF regions without text matching", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                file_key: "source.pdf",
                start_page: 2,
                end_page: 2,
                chunks: [
                    {
                        id: 1,
                        type: "text",
                        text: "Alpha chunk",
                        startPage: 2,
                        endPage: 2,
                        regions: [
                            {
                                kind: "text",
                                page: 2,
                                width: 200,
                                height: 100,
                                rectangles: [{ left: 0.2, top: 0.3, width: 0.1, height: 0.05 }],
                            },
                        ],
                    },
                ],
            })
        );

        expect(reference.pdf_regions).toHaveLength(1);
        const region = reference.pdf_regions[0]!;
        expect(region).toMatchObject({
            kind: "text",
            chunk_id: 1,
            page: 2,
            width: 200,
            height: 100,
            image_path: "/graphs/graph-1/units/unit-1/pages/2.png",
            rectangles: [{ left: 0.2, top: 0.3, width: 0.1, height: 0.05 }],
        });
        expect(region.crop.left).toBeCloseTo(0.075);
        expect(region.crop.top).toBeCloseTo(0.24);
        expect(region.crop.width).toBeCloseTo(0.35);
        expect(region.crop.height).toBeCloseTo(0.17);
        expect(reference.chunks).toEqual([]);
    });

    test("clamps PDF crops when source rectangles are near page edges", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                source_chunk_ids: [1],
                chunks: [
                    {
                        id: 1,
                        type: "text",
                        text: "Top edge chunk",
                        startPage: 1,
                        endPage: 1,
                        regions: [
                            {
                                kind: "text",
                                page: 1,
                                width: 200,
                                height: 100,
                                rectangles: [{ left: 0.95, top: 0.01, width: 0.04, height: 0.02 }],
                            },
                        ],
                    },
                ],
            })
        );

        expect(reference.pdf_regions[0]?.crop).toEqual({
            left: 0.65,
            top: 0,
            width: 0.35,
            height: 0.16,
        });
    });

    test("ignores malformed PDF rectangles when computing stored crops", async () => {
        const validRectangle = { left: 0.2, top: 0.3, width: 0.1, height: 0.05 };
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                source_chunk_ids: [1],
                chunks: [
                    {
                        id: 1,
                        type: "text",
                        text: "Chunk with one usable rectangle",
                        startPage: 1,
                        endPage: 1,
                        regions: [
                            {
                                kind: "text",
                                page: 1,
                                width: 200,
                                height: 100,
                                rectangles: [{ left: Number.NaN, top: 0.1, width: 0.2, height: 0.03 }, validRectangle],
                            },
                        ],
                    },
                ],
            })
        );

        expect(reference.pdf_regions).toHaveLength(1);
        expect(reference.pdf_regions[0]?.rectangles).toEqual([validRectangle]);
        expect(reference.pdf_regions[0]?.crop.left).toBeCloseTo(0.075);
        expect(reference.pdf_regions[0]?.crop.top).toBeCloseTo(0.24);
        expect(reference.pdf_regions[0]?.crop.width).toBeCloseTo(0.35);
        expect(reference.pdf_regions[0]?.crop.height).toBeCloseTo(0.17);
        expect(reference.chunks).toEqual([]);
    });

    test("falls back to selected PDF text chunks when malformed regions cannot produce a preview", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                start_page: null,
                end_page: null,
                source_chunk_ids: [1],
                chunks: [
                    {
                        id: 1,
                        type: "text",
                        text: "Stored PDF text without usable rectangles",
                        startPage: null,
                        endPage: null,
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
            })
        );

        expect(reference.pdf_regions).toEqual([]);
        expect(reference.chunks).toEqual([
            { type: "text", chunk_id: 1, text: "Stored PDF text without usable rectangles" },
        ]);
    });

    test("keeps legacy PDF page previews for migrated synthetic chunks without stored regions", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                start_page: 2,
                end_page: 2,
                source_chunk_ids: [1],
                chunks: [{ id: 1, type: "text", text: "Migrated legacy text", startPage: 2, endPage: 2 }],
            })
        );

        expect(reference.chunks).toEqual([]);
        expect(reference.pdf_regions).toEqual([
            {
                kind: "page",
                chunk_id: 2,
                page: 2,
                width: 1200,
                height: 1600,
                image_path: "/graphs/graph-1/units/unit-1/pages/2.png",
                crop: { left: 0, top: 0, width: 1, height: 1 },
                rectangles: [{ left: 0, top: 0, width: 1, height: 1 }],
            },
        ]);
    });

    test("returns PDF regions for PDF image chunks instead of image paths", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "document.pdf",
                file_type: "pdf",
                mime_type: "application/pdf",
                start_page: 4,
                end_page: 4,
                source_chunk_ids: [1],
                chunks: [
                    {
                        id: 1,
                        type: "image",
                        text: "Chart image",
                        imageId: "img-1",
                        imageKey: null,
                        startPage: 4,
                        endPage: 4,
                        regions: [
                            {
                                kind: "image",
                                page: 4,
                                width: 200,
                                height: 100,
                                rectangles: [{ left: 0.1, top: 0.2, width: 0.4, height: 0.3 }],
                            },
                        ],
                    },
                ],
            })
        );

        expect(reference.pdf_regions).toHaveLength(1);
        const region = reference.pdf_regions[0]!;
        expect(region).toMatchObject({
            kind: "image",
            chunk_id: 1,
            page: 4,
            width: 200,
            height: 100,
            image_path: "/graphs/graph-1/units/unit-1/pages/4.png",
            rectangles: [{ left: 0.1, top: 0.2, width: 0.4, height: 0.3 }],
        });
        expect(region.crop.left).toBeCloseTo(0.06);
        expect(region.crop.top).toBeCloseTo(0.14);
        expect(region.crop.width).toBeCloseTo(0.48);
        expect(region.crop.height).toBeCloseTo(0.42);
        expect(reference.chunks).toEqual([]);
    });

    test("returns protected image paths for embedded image chunks", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                source_chunk_ids: [2],
                chunks: [
                    { id: 1, type: "text", text: "Alpha chunk", startPage: null, endPage: null },
                    {
                        id: 2,
                        type: "image",
                        text: "Chart image",
                        imageId: "img-1",
                        imageKey: "graphs/g-1/file-1.pdf/file-1/images/img-1.png",
                        startPage: null,
                        endPage: null,
                    },
                ],
            })
        );

        expect(reference.chunks).toEqual([
            {
                type: "image",
                chunk_id: 2,
                image_path: "/graphs/graph-1/sources/source-1/chunks/2/image",
                alt: "Chart image",
            },
        ]);
    });

    test("URL-encodes protected image paths for graph and source ids", async () => {
        const reference = await toSourceReferenceRecord(
            "graph 1",
            sourceRow({
                source_id: "source/1",
                source_chunk_ids: [2],
                chunks: [
                    {
                        id: 2,
                        type: "image",
                        text: "Chart image",
                        imageId: "img-1",
                        imageKey: "graphs/g-1/file-1.pdf/file-1/images/img-1.png",
                        startPage: null,
                        endPage: null,
                    },
                ],
            })
        );

        expect(reference.chunks).toEqual([
            {
                type: "image",
                chunk_id: 2,
                image_path: "/graphs/graph%201/sources/source%2F1/chunks/2/image",
                alt: "Chart image",
            },
        ]);
    });

    test("returns the original file proxy path for top-level image chunks", async () => {
        const reference = await toSourceReferenceRecord(
            "graph-1",
            sourceRow({
                file_name: "photo.png",
                file_type: "image",
                mime_type: "image/png",
                source_chunk_ids: [1],
                chunks: [
                    {
                        id: 1,
                        type: "image",
                        text: "Photo description",
                        imageId: null,
                        imageKey: null,
                        startPage: null,
                        endPage: null,
                    },
                ],
            })
        );

        expect(reference.chunks).toEqual([
            {
                type: "image",
                chunk_id: 1,
                image_path: "/graphs/graph-1/files/file-1/photo.png",
                alt: "Photo description",
            },
        ]);
    });
});

describe("selectSourceChunks", () => {
    test("does not guess among multiple chunks when attribution is missing", () => {
        const chunks = Array.from({ length: 12 }, (_, index) => ({
            id: index + 1,
            type: "text" as const,
            text: `Chunk ${index + 1}`,
            startPage: null,
            endPage: null,
        }));

        expect(selectSourceChunks(chunks, [])).toEqual([]);
    });

    test("uses the only stored chunk when attribution is missing", () => {
        const chunks = [{ id: 1, type: "text" as const, text: "Only chunk", startPage: null, endPage: null }];

        expect(selectSourceChunks(chunks, [])).toEqual(chunks);
    });
});
