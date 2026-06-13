import { describe, expect, test } from "bun:test";
import { MockTranscriptionModelV3 } from "ai/test";

import { AudioLoader } from "../audio";
import { CSVLoader } from "../csv";
import { DOCXLoader } from "../doc";
import { ExcelLoader } from "../excel";
import { BufferedGraphBinaryLoader, createDetectedGraphLoader, detectGraphFileFormat } from "../factory";
import { PDFLoader } from "../pdf";
import { PPTXLoader } from "../ppt";
import { VideoLoader } from "../video";
import { XMLLoader } from "../xml";

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

    test("uses the JSON loader path for JSONL and JSONC declared types", () => {
        const jsonl = detectGraphFileFormat({
            declaredType: "jsonl",
            mimeType: "application/x-ndjson; charset=utf-8",
            content: toArrayBuffer(encodeASCII('{"ok":true}\n{"ok":false}')),
        });
        const jsonc = detectGraphFileFormat({
            declaredType: "jsonc",
            mimeType: "application/jsonc; charset=utf-8",
            content: toArrayBuffer(encodeASCII('{"ok":true,}')),
        });

        expect(jsonl).toEqual({
            fileType: "jsonl",
            loaderKind: "json",
            mimeType: "application/x-ndjson",
            sniffed: false,
        });
        expect(jsonc).toEqual({
            fileType: "jsonc",
            loaderKind: "json",
            mimeType: "application/jsonc",
            sniffed: false,
        });
    });

    test("uses the XML loader for XML and keeps other structured text file types on the text loader path", () => {
        const xml = detectGraphFileFormat({
            declaredType: "xml",
            mimeType: "application/xml; charset=utf-8",
            content: toArrayBuffer(encodeASCII("<root />")),
        });
        const yaml = detectGraphFileFormat({
            declaredType: "yaml",
            mimeType: "text/yaml",
            content: toArrayBuffer(encodeASCII("root:\n  ok: true")),
        });
        const toml = detectGraphFileFormat({
            declaredType: "toml",
            mimeType: "application/toml",
            content: toArrayBuffer(encodeASCII("[root]\nok = true")),
        });
        const csv = detectGraphFileFormat({
            declaredType: "csv",
            mimeType: "text/csv",
            content: toArrayBuffer(encodeASCII("name,value\nAlice,1")),
        });

        expect(xml).toEqual({
            fileType: "xml",
            loaderKind: "xml",
            mimeType: "application/xml",
            sniffed: false,
        });
        expect(yaml.loaderKind).toBe("text");
        expect(yaml.fileType).toBe("yaml");
        expect(toml.loaderKind).toBe("text");
        expect(toml.fileType).toBe("toml");
        expect(csv.loaderKind).toBe("csv");
        expect(csv.fileType).toBe("csv");
    });

    test("keeps declared audio on the audio loader path", () => {
        const format = detectGraphFileFormat({
            declaredType: "audio",
            mimeType: "audio/mpeg",
            content: toArrayBuffer(Uint8Array.of(0x49, 0x44, 0x33, 0x04)),
        });

        expect(format).toEqual({
            fileType: "audio",
            loaderKind: "audio",
            mimeType: "audio/mpeg",
            sniffed: false,
        });
    });

    test("does not reclassify audio WebM containers as video", () => {
        const format = detectGraphFileFormat({
            declaredType: "audio",
            mimeType: "audio/webm",
            content: toArrayBuffer(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x00)),
        });

        expect(format).toEqual({
            fileType: "audio",
            loaderKind: "audio",
            mimeType: "audio/webm",
            sniffed: false,
        });
    });

    test("routes audio-only WebM containers through the audio loader path", () => {
        const format = detectGraphFileFormat({
            declaredType: "video",
            mimeType: "video/webm",
            content: toArrayBuffer(fakeEBMLWithTrackType(2)),
        });

        expect(format).toEqual({
            fileType: "audio",
            loaderKind: "audio",
            mimeType: "audio/webm",
            sniffed: true,
        });
    });

    test("keeps declared video on the video loader path", () => {
        const format = detectGraphFileFormat({
            declaredType: "video",
            mimeType: "video/mp4",
            content: toArrayBuffer(encodeASCII("not enough for sniffing")),
        });

        expect(format).toEqual({
            fileType: "video",
            loaderKind: "video",
            mimeType: "video/mp4",
            sniffed: false,
        });
    });

    test("detects common video signatures regardless of declared type", () => {
        const mp4 = detectGraphFileFormat({
            declaredType: "text",
            mimeType: "text/plain",
            content: toArrayBuffer(Uint8Array.of(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d)),
        });
        const webm = detectGraphFileFormat({
            declaredType: "text",
            mimeType: "text/plain",
            content: toArrayBuffer(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x00)),
        });

        expect(mp4).toEqual({
            fileType: "video",
            loaderKind: "video",
            mimeType: "video/mp4",
            sniffed: true,
        });
        expect(webm).toEqual({
            fileType: "video",
            loaderKind: "video",
            mimeType: "video/webm",
            sniffed: true,
        });
    });

    test("does not treat plain text starting with From as mbox", () => {
        const format = detectGraphFileFormat({
            declaredType: "text",
            mimeType: "text/plain",
            content: toArrayBuffer(encodeASCII("From here we can see the whole branch.\nNo email headers.")),
        });

        expect(format).toEqual({
            fileType: "text",
            loaderKind: "text",
            mimeType: "text/plain",
            sniffed: false,
        });
    });

    test("does not route non-email mbox-looking content through the email loader", () => {
        const content = toArrayBuffer(
            encodeASCII("From user@example.com Mon Jan 01 12:00:00 2024\nsubject: release provenance")
        );

        const text = detectGraphFileFormat({
            declaredType: "text",
            mimeType: "text/plain",
            content,
        });
        const yaml = detectGraphFileFormat({
            declaredType: "yaml",
            mimeType: "text/yaml",
            content,
        });
        const email = detectGraphFileFormat({
            declaredType: "email",
            mimeType: "message/rfc822",
            content,
        });

        expect(text).toEqual({
            fileType: "text",
            loaderKind: "text",
            mimeType: "text/plain",
            sniffed: false,
        });
        expect(yaml).toEqual({
            fileType: "yaml",
            loaderKind: "text",
            mimeType: "text/yaml",
            sniffed: false,
        });
        expect(email).toEqual({
            fileType: "email",
            loaderKind: "email",
            mimeType: "application/mbox",
            sniffed: true,
        });
    });

    test("does not treat a single email-looking structured key as email", () => {
        const yaml = detectGraphFileFormat({
            declaredType: "yaml",
            mimeType: "text/yaml",
            content: toArrayBuffer(encodeASCII("date: 2024-01-01\nname: release")),
        });
        const text = detectGraphFileFormat({
            declaredType: "text",
            mimeType: "text/plain",
            content: toArrayBuffer(encodeASCII("Subject: notes\n\nNot an email.")),
        });

        expect(yaml).toEqual({
            fileType: "yaml",
            loaderKind: "text",
            mimeType: "text/yaml",
            sniffed: false,
        });
        expect(text).toEqual({
            fileType: "text",
            loaderKind: "text",
            mimeType: "text/plain",
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

    test("creates a CSV loader from declared CSV files", () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(encodeASCII("id,name\n1,Alice")),
            declaredType: "csv",
            documentMode: "plain",
        });

        expect(result.loader).toBeInstanceOf(CSVLoader);
        expect(result.format.loaderKind).toBe("csv");
    });

    test("rejects binary files declared as CSV", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(Uint8Array.of(0x00, 0x01, 0x02, 0x03, 0x04)),
                declaredType: "csv",
                documentMode: "plain",
            })
        ).toThrow("Invalid CSV content");
    });

    test("rejects legacy Office document formats", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00)),
                declaredType: "doc",
                documentMode: "plain",
            })
        ).toThrow("Unsupported file type");
    });

    test("rejects unknown binary files that would otherwise fall back to text", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(Uint8Array.of(0x00, 0x01, 0x02, 0x03, 0x04)),
                declaredType: "text",
                documentMode: "plain",
            })
        ).toThrow("Unsupported file type");
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

    test("creates audio loaders when an audio transcription model is configured", () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(Uint8Array.of(0x49, 0x44, 0x33, 0x04)),
            declaredType: "audio",
            mimeType: "audio/mpeg",
            audioModel: new MockTranscriptionModelV3(),
        });

        expect(result.loader).toBeInstanceOf(AudioLoader);
        expect(result.format.loaderKind).toBe("audio");
    });

    test("creates audio loaders for audio WebM containers", () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x00)),
            declaredType: "audio",
            mimeType: "audio/webm",
            audioModel: new MockTranscriptionModelV3(),
        });

        expect(result.loader).toBeInstanceOf(AudioLoader);
        expect(result.format.loaderKind).toBe("audio");
    });

    test("creates audio loaders for audio-only WebM containers when audio transcription is configured", () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(fakeEBMLWithTrackType(2)),
            declaredType: "video",
            mimeType: "video/webm",
            audioModel: new MockTranscriptionModelV3(),
            videoModel: new MockTranscriptionModelV3(),
        });

        expect(result.loader).toBeInstanceOf(AudioLoader);
        expect(result.format).toMatchObject({
            fileType: "audio",
            loaderKind: "audio",
            mimeType: "audio/webm",
        });
    });

    test("falls back to video loaders for audio-only WebM containers when only video transcription is configured", () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(fakeEBMLWithTrackType(2)),
            declaredType: "video",
            mimeType: "video/webm",
            videoModel: new MockTranscriptionModelV3(),
        });

        expect(result.loader).toBeInstanceOf(VideoLoader);
        expect(result.format).toMatchObject({
            fileType: "video",
            loaderKind: "video",
            mimeType: "video/webm",
        });
    });

    test("creates video loaders when a video transcription model is configured", () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(encodeASCII("not enough for sniffing")),
            declaredType: "video",
            mimeType: "video/mp4",
            videoModel: new MockTranscriptionModelV3(),
        });

        expect(result.loader).toBeInstanceOf(VideoLoader);
        expect(result.format.loaderKind).toBe("video");
    });

    test("creates XML loaders that render structured text", async () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(encodeASCII('<catalog><book id="1">One</book></catalog>')),
            declaredType: "xml",
            mimeType: "application/xml",
        });

        await expect(result.loader.getText()).resolves.toContain("### /catalog/book[1]");
        expect(result.loader).toBeInstanceOf(XMLLoader);
        expect(result.format.loaderKind).toBe("xml");
    });

    test("creates CSV loaders without routing CSV content through Excel workbook parsing", async () => {
        const result = createDetectedGraphLoader({
            content: toArrayBuffer(encodeASCII("name,value\nAlice,1")),
            declaredType: "csv",
            mimeType: "text/csv",
        });

        expect(result.loader).toBeInstanceOf(CSVLoader);
        expect(result.format.loaderKind).toBe("csv");
        await expect(result.loader.getText()).resolves.toBe("name,value\nAlice,1");
    });

    test("rejects binary content declared as CSV", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(Uint8Array.of(0x00, 0x01, 0x02, 0x03)),
                declaredType: "csv",
                mimeType: "text/csv",
            })
        ).toThrow("Invalid CSV content: binary files are not valid CSV");
    });

    test("rejects binary content declared as JSON-family text", () => {
        for (const declaredType of ["json", "jsonl", "jsonc"] as const) {
            expect(() =>
                createDetectedGraphLoader({
                    content: toArrayBuffer(Uint8Array.of(0x00, 0x01, 0x02, 0x03)),
                    declaredType,
                    mimeType: "application/octet-stream",
                })
            ).toThrow("Invalid JSON content: binary files are not valid JSON");
        }
    });

    test("rejects binary content on text loaders and legacy Office content on OOXML loaders", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(Uint8Array.of(0x00, 0x01, 0x02, 0x03)),
                declaredType: "text",
                mimeType: "text/plain",
            })
        ).toThrow("Unsupported file type: binary files are not supported");

        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)),
                declaredType: "doc",
                mimeType: "application/msword",
                documentMode: "plain",
            })
        ).toThrow("Unsupported file type: legacy Office documents are not supported");
    });

    test("throws when audio has no transcription model", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(Uint8Array.of(0x49, 0x44, 0x33, 0x04)),
                declaredType: "audio",
                mimeType: "audio/mpeg",
            })
        ).toThrow("Audio transcription requires an audio transcription model");
    });

    test("throws when video has no transcription model", () => {
        expect(() =>
            createDetectedGraphLoader({
                content: toArrayBuffer(encodeASCII("not enough for sniffing")),
                declaredType: "video",
                mimeType: "video/mp4",
            })
        ).toThrow("Video transcription requires a video transcription model");
    });
});

function fakeZipWithEntry(entry: string): ArrayBuffer {
    return toArrayBuffer(encodeASCII(`PK\u0003\u0004\x14\x00${entry}\x00payload`));
}

function fakeEBMLWithTrackType(trackType: 1 | 2): Uint8Array {
    return Uint8Array.of(
        0x1a,
        0x45,
        0xdf,
        0xa3,
        0x80,
        0x18,
        0x53,
        0x80,
        0x67,
        0x88,
        0x16,
        0x54,
        0xae,
        0x6b,
        0x83,
        0xae,
        0x81,
        0x83,
        0x81,
        trackType
    );
}

function encodeASCII(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
