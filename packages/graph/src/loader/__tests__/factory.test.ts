import { describe, expect, test } from "bun:test";

import { DOCXLoader } from "../doc";
import { ExcelLoader } from "../excel";
import { BufferedGraphBinaryLoader, createDetectedGraphLoader, detectGraphFileFormat } from "../factory";
import { PDFLoader } from "../pdf";
import { PPTXLoader } from "../ppt";

describe("detectGraphFileFormat", () => {
    test("prefers the PDF parser when a doc file is actually a PDF", () => {
        const format = detectGraphFileFormat({
            declaredType: "doc",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            content: toArrayBuffer(encodeASCII("%PDF-1.7\nrest of file")),
        });

        expect(format).toEqual({
            fileType: "pdf",
            loaderKind: "pdf",
            mimeType: "application/pdf",
            sniffed: true,
        });
    });

    test("prefers the DOCX parser when a pdf file is actually an OOXML word package", () => {
        const format = detectGraphFileFormat({
            declaredType: "pdf",
            mimeType: "application/pdf",
            content: fakeZipWithEntry("word/document.xml"),
        });

        expect(format).toEqual({
            fileType: "doc",
            loaderKind: "docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sniffed: true,
        });
    });

    test("distinguishes OOXML presentation and spreadsheet packages", () => {
        const presentation = detectGraphFileFormat({
            declaredType: "sheet",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            content: fakeZipWithEntry("ppt/presentation.xml"),
        });
        const spreadsheet = detectGraphFileFormat({
            declaredType: "ppt",
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            content: fakeZipWithEntry("xl/workbook.xml"),
        });

        expect(presentation.fileType).toBe("ppt");
        expect(presentation.loaderKind).toBe("pptx");
        expect(spreadsheet.fileType).toBe("sheet");
        expect(spreadsheet.loaderKind).toBe("sheet");
    });

    test("detects common image signatures regardless of declared type", () => {
        const png = detectGraphFileFormat({
            declaredType: "text",
            mimeType: "text/plain",
            content: toArrayBuffer(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)),
        });
        const jpeg = detectGraphFileFormat({
            declaredType: "pdf",
            mimeType: "application/pdf",
            content: toArrayBuffer(Uint8Array.of(0xff, 0xd8, 0xff, 0xee)),
        });

        expect(png).toMatchObject({
            fileType: "image",
            loaderKind: "image",
            mimeType: "image/png",
            sniffed: true,
        });
        expect(jpeg).toMatchObject({
            fileType: "image",
            loaderKind: "image",
            mimeType: "image/jpeg",
            sniffed: true,
        });
    });

    test("falls back to the declared type when the content is not recognized", () => {
        const format = detectGraphFileFormat({
            declaredType: "json",
            mimeType: "application/json; charset=utf-8",
            content: toArrayBuffer(encodeASCII('{"ok":true}')),
        });

        expect(format).toEqual({
            fileType: "json",
            loaderKind: "json",
            mimeType: "application/json",
            sniffed: false,
        });
    });
});

describe("BufferedGraphBinaryLoader", () => {
    test("serves both binary and decoded text from the same buffer", async () => {
        const content = toArrayBuffer(encodeASCII("hello world"));
        const loader = new BufferedGraphBinaryLoader(content);

        await expect(loader.getBinary()).resolves.toBe(content);
        await expect(loader.getText()).resolves.toBe("hello world");
    });
});

describe("createDetectedGraphLoader", () => {
    test("creates a PDF loader without an image model in plain mode", () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(encodeASCII("%PDF-1.7\nrest of file")),
            declaredType: "pdf",
            documentMode: "plain",
        });

        expect(result.loader).toBeInstanceOf(PDFLoader);
        expect(result.format.loaderKind).toBe("pdf");
    });

    test("creates the OOXML document loaders from sniffed content", () => {
        const imageModel = {} as never;
        const storage = { bucket: "bucket", imagePrefix: "graphs/graph-1/files/file-1/images" };

        const doc = createDetectedGraphLoader({
            content: fakeZipWithEntry("word/document.xml"),
            declaredType: "pdf",
            documentMode: "plain",
        });
        const sheet = createDetectedGraphLoader({
            content: fakeZipWithEntry("xl/workbook.xml"),
            declaredType: "ppt",
            documentMode: "plain",
        });
        const ppt = createDetectedGraphLoader({
            content: fakeZipWithEntry("ppt/presentation.xml"),
            declaredType: "sheet",
            imageModel,
            derivedImageStorage: storage,
        });

        expect(doc.loader).toBeInstanceOf(DOCXLoader);
        expect(sheet.loader).toBeInstanceOf(ExcelLoader);
        expect(ppt.loader).toBeInstanceOf(PPTXLoader);
    });

    test("throws when PDF hybrid mode has no image model", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(encodeASCII("%PDF-1.7\nrest of file")),
                declaredType: "pdf",
            })
        ).toThrow("PDF hybrid requires an image-capable model");
    });

    test("throws when document OCR needs model or derived image storage", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: fakeZipWithEntry("word/document.xml"),
                declaredType: "doc",
            })
        ).toThrow("Document OCR requires an image-capable model");

        expect(() =>
            createDetectedGraphLoader({
                content: fakeZipWithEntry("ppt/presentation.xml"),
                declaredType: "ppt",
                imageModel: {} as never,
            })
        ).toThrow("Presentation OCR requires derived image storage");
    });
});

function fakeZipWithEntry(entry: string): ArrayBuffer {
    return toArrayBuffer(encodeASCII(`PK\u0003\u0004\x14\x00${entry}\x00payload`));
}

function encodeASCII(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
