import { describe, expect, test } from "bun:test";
import { XMLChunker } from "../xml.ts";

describe("XMLChunker", () => {
    test("returns no chunks for empty input", async () => {
        const chunks = await new XMLChunker({ maxChunkSize: 100 }).getChunks("");

        expect(chunks).toEqual([]);
    });

    test("returns small XML as a single chunk", async () => {
        const input = '<catalog><book id="1">One</book></catalog>';
        const chunks = await new XMLChunker({ maxChunkSize: 100 }).getChunks(input);

        expect(chunks).toEqual([input]);
    });

    test("splits large XML while keeping element context", async () => {
        const input = `<?xml version="1.0"?><catalog source="fixture"><book id="1"><title>One</title><summary>${"alpha ".repeat(80)}</summary></book><book id="2"><title>Two</title><summary>${"beta ".repeat(80)}</summary></book></catalog>`;
        const chunks = await new XMLChunker({ maxChunkSize: 30 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain('<?xml version="1.0"?>');
        expect(joined).toContain("Path: /catalog");
        expect(joined).toContain('<book id="1">');
        expect(joined).toContain('<book id="2">');
    });

    test("keeps comments and CDATA sections when chunking", async () => {
        const input = [
            '<?xml version="1.0"?>',
            "<feed>",
            "<!-- editorial note -->",
            `<entry><![CDATA[${"alpha ".repeat(80)}]]></entry>`,
            "</feed>",
        ].join("");
        const chunks = await new XMLChunker({ maxChunkSize: 24 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain("<!-- editorial note -->");
        expect(joined).toContain("<![CDATA[");
        expect(joined).toContain("Path: /feed");
    });

    test("falls back to one chunk for malformed XML", async () => {
        const input = "<catalog><book>open only";
        const chunks = await new XMLChunker({ maxChunkSize: 5 }).getChunks(input);

        expect(chunks).toEqual([input]);
    });
});
