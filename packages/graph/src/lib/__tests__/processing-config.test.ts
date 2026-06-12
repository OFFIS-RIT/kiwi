import { describe, expect, test } from "bun:test";

import { SemanticChunker } from "../../chunking/semantic";
import { SingleChunker } from "../../chunking/single";
import { TranscriptChunker } from "../../chunking/transcript";
import { createGraphChunker } from "../../chunking/factory";
import {
    defaultFileTypeProcessingConfig,
    fileTypeSupportsChunkSize,
    fileTypeSupportsDocumentMode,
    resolveFileTypeProcessingConfig,
} from "../processing-config";

describe("defaultFileTypeProcessingConfig", () => {
    test("matches the previously hardcoded processing values", () => {
        expect(defaultFileTypeProcessingConfig("pdf")).toEqual({
            loader: "pdf",
            chunker: "semantic",
            chunkSize: 2000,
            documentMode: "hybrid",
        });
        expect(defaultFileTypeProcessingConfig("image")).toEqual({
            loader: "image",
            chunker: "single",
            chunkSize: null,
            documentMode: null,
        });
        expect(defaultFileTypeProcessingConfig("audio")).toEqual({
            loader: "audio",
            chunker: "transcript",
            chunkSize: 500,
            documentMode: null,
        });
        expect(defaultFileTypeProcessingConfig("yaml")).toEqual({
            loader: "text",
            chunker: "yaml",
            chunkSize: 500,
            documentMode: null,
        });
    });
});

describe("resolveFileTypeProcessingConfig", () => {
    test("returns defaults when no overrides exist", () => {
        expect(resolveFileTypeProcessingConfig("text", null)).toEqual(defaultFileTypeProcessingConfig("text"));
    });

    test("applies stored chunk size and document mode", () => {
        const config = resolveFileTypeProcessingConfig("pdf", {
            chunker: "semantic",
            chunkSize: 1200,
            documentMode: "ocr",
        });

        expect(config.chunkSize).toBe(1200);
        expect(config.documentMode).toBe("ocr");
    });

    test("falls back to defaults for unknown chunker or document mode values", () => {
        const config = resolveFileTypeProcessingConfig("pdf", {
            chunker: "bogus",
            chunkSize: null,
            documentMode: "bogus",
        });

        expect(config).toEqual(defaultFileTypeProcessingConfig("pdf"));
    });

    test("keeps the loader fixed per file type", () => {
        const config = resolveFileTypeProcessingConfig("doc", {
            chunker: "semantic",
            chunkSize: 1000,
            documentMode: "plain",
        });

        expect(config.loader).toBe("docx");
    });
});

describe("capability checks", () => {
    test("single-chunked file types do not support a chunk size", () => {
        expect(fileTypeSupportsChunkSize("image")).toBe(false);
        expect(fileTypeSupportsChunkSize("pdf")).toBe(true);
    });

    test("only OCR-capable document types support a document mode", () => {
        expect(fileTypeSupportsDocumentMode("pdf")).toBe(true);
        expect(fileTypeSupportsDocumentMode("doc")).toBe(true);
        expect(fileTypeSupportsDocumentMode("ppt")).toBe(true);
        expect(fileTypeSupportsDocumentMode("csv")).toBe(false);
    });
});

describe("createGraphChunker", () => {
    test("creates the chunker class for the kind", () => {
        expect(createGraphChunker("single", null)).toBeInstanceOf(SingleChunker);
        expect(createGraphChunker("semantic", 2000)).toBeInstanceOf(SemanticChunker);
        expect(createGraphChunker("transcript", 500)).toBeInstanceOf(TranscriptChunker);
    });
});
