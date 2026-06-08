import { describe, expect, test } from "bun:test";
import { HTMLChunker } from "../../chunking/html";
import { BufferedGraphBinaryLoader } from "../factory";
import { HTMLLoader } from "../html";
import { WebLoader } from "../web";

describe("HTMLLoader", () => {
    test("converts HTML content to markdown", async () => {
        const loader = new HTMLLoader({
            loader: new BufferedGraphBinaryLoader(
                toArrayBuffer(
                    encode(
                        `<html><head><title>Ignored</title><script>bad()</script></head><body><h1>Title</h1><p>Hello <strong>world</strong>.</p><ul><li>One</li><li><a href="https://example.com">Two</a></li></ul></body></html>`
                    )
                )
            ),
            mode: "content",
        });

        const text = await loader.getText();

        expect(text).toContain("# Title");
        expect(text).toContain("Hello **world**.");
        expect(text).toContain("- One");
        expect(text).toContain("[Two](https://example.com)");
        expect(text).not.toContain("bad()");
    });

    test("normalizes malformed HTML in html mode", async () => {
        const loader = new HTMLLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(encode("<main><p>Hello <strong>world"))),
            mode: "html",
        });

        await expect(loader.getText()).resolves.toBe("<main><p>Hello <strong>world</strong></p></main>");
    });
});

describe("HTMLChunker", () => {
    test("chunks HTML while keeping body wrappers closed", async () => {
        const html = `<html><body><section><h1>First</h1><p>${"alpha ".repeat(120)}</p></section><section><h1>Second</h1><p>${"beta ".repeat(120)}</p></section></body></html>`;

        const chunks = await new HTMLChunker({ maxChunkSize: 80 }).getChunks(html);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.includes("<body>") && chunk.includes("</body>"))).toBe(true);
    });
});

describe("WebLoader", () => {
    test("loads text and bytes from a URL once", async () => {
        let calls = 0;
        const loader = new WebLoader("https://example.com/page.html", {
            fetch: async () => {
                calls += 1;
                return new Response("<html></html>", {
                    headers: {
                        "content-type": "text/html; charset=utf-8",
                    },
                });
            },
        });

        await expect(loader.getText()).resolves.toBe("<html></html>");
        await expect(loader.getMimeType()).resolves.toBe("text/html; charset=utf-8");
        expect(new TextDecoder().decode(await loader.getBinary())).toBe("<html></html>");
        expect(calls).toBe(1);
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
