import { describe, expect, test } from "bun:test";
import { analyzePageContent, createTokenizer } from "../content";
import type { PDFArrayLike, PDFDictLike, PDFDocumentLike, PDFPageLike, PDFStreamLike } from "../types";

const encoder = new TextEncoder();

describe("PDF content parser", () => {
    test("parses marked-content dictionaries split across page content streams", () => {
        const pdf = fakePDF();
        const page = fakePage(["/P <</MCID ", "24 >>BDC\n0 0 m\n10 0 l\nS\nEMC\n"]);

        const content = analyzePageContent(pdf, page, () => "img-1");

        expect(content.explicitEdges).toHaveLength(1);
        expect(content.explicitEdges[0]).toMatchObject({
            orientation: "horizontal",
            position: 0,
            start: 0,
            end: 10,
        });
    });

    test("separates adjacent operators at content stream boundaries", () => {
        const pdf = fakePDF();
        const page = fakePage(["q", "Q\n0 0 m\n10 0 l\nS\n"]);

        const content = analyzePageContent(pdf, page, () => "img-1");

        expect(content.explicitEdges).toHaveLength(1);
    });

    test("advances past unexpected delimiter tokens", () => {
        const tokenizer = createTokenizer(encoder.encode(">>BDC"));

        expect(tokenizer.next()).toEqual({ kind: "operator", value: ">" });
        expect(tokenizer.next()).toEqual({ kind: "operator", value: ">" });
        expect(tokenizer.next()).toEqual({ kind: "operator", value: "BDC" });
        expect(tokenizer.next()).toBeNull();
    });
});

function fakePDF(): PDFDocumentLike {
    return {
        getPages: () => [],
        getObject: (ref) => ref,
    };
}

function fakePage(contents: string[]): PDFPageLike {
    return {
        index: 0,
        width: 100,
        height: 100,
        dict: fakeDict({ Contents: fakeArray(contents.map(fakeStream)) }),
        getResources: () => fakeDict({}),
        extractText: () => ({
            pageIndex: 0,
            width: 100,
            height: 100,
            lines: [],
            text: "",
        }),
    };
}

function fakeStream(content: string): PDFStreamLike {
    const bytes = encoder.encode(content);

    return {
        ...fakeDict({}),
        type: "stream",
        data: bytes,
        getDecodedData: () => bytes,
    };
}

function fakeDict(values: Record<string, unknown>): PDFDictLike {
    return {
        type: "dict",
        get: (key) => {
            const name = typeof key === "string" ? key : key.value;
            return values[name];
        },
        getArray: (key) => {
            const value = values[key];
            return isFakeArray(value) ? value : undefined;
        },
        getDict: () => undefined,
        getName: () => undefined,
        getNumber: () => undefined,
        *[Symbol.iterator]() {
            for (const [key, value] of Object.entries(values)) {
                yield [{ type: "name", value: key }, value] as const;
            }
        },
    };
}

function fakeArray(items: unknown[]): PDFArrayLike {
    return {
        type: "array",
        length: items.length,
        at: (index) => items[index],
        *[Symbol.iterator]() {
            yield* items;
        },
    };
}

function isFakeArray(value: unknown): value is PDFArrayLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "array";
}
