import { describe, expect, test } from "bun:test";
import { SemanticChunker } from "../../chunking/semantic";
import { BufferedGraphBinaryLoader } from "../factory";
import { XMLLoader, xmlToStructuredText } from "../xml";

describe("XMLLoader", () => {
    test("renders XML as structured markdown for extraction", async () => {
        const loader = new XMLLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(encode('<catalog><book id="1">One</book></catalog>'))),
        });

        await expect(loader.getText()).resolves.toBe(
            [
                "# XML Document",
                "",
                "## /catalog",
                "",
                "### /catalog/book[1]",
                "",
                "Attributes:",
                "- id: 1",
                "",
                "One",
            ].join("\n")
        );
    });

    test("keeps readable paths attributes comments and CDATA", () => {
        const text = xmlToStructuredText(
            [
                '<?xml version="1.0"?>',
                '<feed source="fixture">',
                "<!-- editorial note -->",
                `<entry id="a"><![CDATA[Alpha & Beta]]></entry>`,
                "</feed>",
            ].join("")
        );

        expect(text).toContain("## /feed");
        expect(text).toContain("- source: fixture");
        expect(text).toContain("Comment: editorial note");
        expect(text).toContain("### /feed/entry[1]");
        expect(text).toContain("- id: a");
        expect(text).toContain("CDATA: Alpha & Beta");
        expect(text).not.toContain("<entry");
    });

    test("decodes XML entity and character references without dropping text", () => {
        const text = xmlToStructuredText('<root title="Tom &amp; Jerry">A &amp; B &lt; C &#169; &#x2014;</root>');

        expect(text).toContain("- title: Tom & Jerry");
        expect(text).toContain("A & B < C \u00a9 \u2014");
    });

    test("ignores processing instructions without falling back to raw XML", () => {
        const text = xmlToStructuredText("<root><?pi value?><child>Text</child></root>");

        expect(text).toContain("## /root");
        expect(text).toContain("### /root/child[1]");
        expect(text).toContain("Text");
        expect(text).not.toContain("<?pi");
    });

    test("falls back to original text for malformed XML", () => {
        const input = "<catalog><book>open only";

        expect(xmlToStructuredText(input)).toBe(input);
    });

    test("falls back to original text for ambiguous XML documents", () => {
        expect(xmlToStructuredText("<a>one</a><b>two</b>")).toBe("<a>one</a><b>two</b>");
        expect(xmlToStructuredText("<root><unclosed></root>")).toBe("<root><unclosed></root>");
    });

    test("produces text that can be split by the semantic chunker", async () => {
        const text = xmlToStructuredText(
            `<catalog source="fixture"><book id="1"><title>One</title><summary>${"alpha ".repeat(
                80
            )}</summary></book><book id="2"><title>Two</title><summary>${"beta ".repeat(80)}</summary></book></catalog>`
        );

        const chunks = await new SemanticChunker(30).getChunks(text);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain("## /catalog");
        expect(joined).toContain("### /catalog/book[1]");
        expect(joined).toContain("### /catalog/book[2]");
        expect(joined).not.toContain("<book");
    });
});

function encode(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
