import { describe, expect, test } from "bun:test";
import { createSourceChunks, DEFAULT_SOURCE_CHUNK_TOKENS } from "../source-chunk";

describe("createSourceChunks", () => {
    test("creates text chunks with the default source chunk token target", async () => {
        const text = Array.from({ length: DEFAULT_SOURCE_CHUNK_TOKENS + 80 }, (_, index) => `word${index}.`).join(" ");

        const chunks = await createSourceChunks(text, { startPage: 2, endPage: 2 });

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.type === "text")).toBe(true);
        expect(chunks[0]).toMatchObject({ id: 1, startPage: 2, endPage: 2 });
        expect(chunks.map((chunk) => chunk.text).join(" ")).toContain("word0");
        expect(chunks.map((chunk) => chunk.text).join(" ")).toContain(`word${DEFAULT_SOURCE_CHUNK_TOKENS + 79}`);
    });

    test("keeps embedded image tags as indivisible image chunks", async () => {
        const chunks = await createSourceChunks(
            [
                "Before text.",
                '<image id="img-1" key="graphs/g-1/f-1.pdf/f-1/images/img-1.png">Chart &lt;A&gt;</image>',
                "After text.",
            ].join("\n"),
            { startPage: 3, endPage: 3 }
        );

        expect(chunks).toEqual([
            { id: 1, type: "text", text: "Before text.", startPage: 3, endPage: 3 },
            {
                id: 2,
                type: "image",
                text: "Chart <A>",
                imageId: "img-1",
                imageKey: "graphs/g-1/f-1.pdf/f-1/images/img-1.png",
                startPage: 3,
                endPage: 3,
            },
            { id: 3, type: "text", text: "After text.", startPage: 3, endPage: 3 },
        ]);
    });

    test("keeps JSON units as one structured source chunk", async () => {
        const content = JSON.stringify(
            {
                records: Array.from({ length: DEFAULT_SOURCE_CHUNK_TOKENS + 80 }, (_, index) => ({
                    id: index,
                    label: `record-${index}`,
                })),
            },
            null,
            2
        );

        await expect(createSourceChunks(content, { fileType: "json" })).resolves.toEqual([
            {
                id: 1,
                type: "text",
                text: content,
                startPage: null,
                endPage: null,
            },
        ]);
    });

    test("keeps sheet units as one structured source chunk", async () => {
        const content = Array.from(
            { length: DEFAULT_SOURCE_CHUNK_TOKENS + 80 },
            (_, index) => `| ${index} | value |`
        ).join("\n");

        await expect(createSourceChunks(content, { fileType: "sheet" })).resolves.toEqual([
            {
                id: 1,
                type: "text",
                text: content,
                startPage: null,
                endPage: null,
            },
        ]);
    });

    test("creates one image chunk for top-level image files", async () => {
        await expect(createSourceChunks("A photo of a receipt.", { fileType: "image" })).resolves.toEqual([
            {
                id: 1,
                type: "image",
                text: "A photo of a receipt.",
                imageId: null,
                imageKey: null,
                startPage: null,
                endPage: null,
            },
        ]);
    });

    test("creates one image chunk for top-level image MIME types", async () => {
        await expect(createSourceChunks("A photo of a receipt.", { fileType: "image/png" })).resolves.toEqual([
            {
                id: 1,
                type: "image",
                text: "A photo of a receipt.",
                imageId: null,
                imageKey: null,
                startPage: null,
                endPage: null,
            },
        ]);
    });
});
