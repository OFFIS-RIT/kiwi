import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { DOCXLoader } from "./doc";
import { ExcelLoader } from "./excel";
import { ImageLoader } from "./image";
import { PDFLoader, type PDFMode } from "./pdf";
import { PPTXLoader } from "./ppt";

export type GraphFileType = "pdf" | "doc" | "sheet" | "ppt" | "image" | "json" | "text";
export type GraphLoaderKind = "pdf" | "docx" | "sheet" | "pptx" | "image" | "json" | "text";

export type DetectedGraphFileFormat = {
    fileType: GraphFileType;
    loaderKind: GraphLoaderKind;
    mimeType: string;
    sniffed: boolean;
};

const DEFAULT_FILE_FORMATS: Record<GraphFileType, Omit<DetectedGraphFileFormat, "sniffed">> = {
    pdf: { fileType: "pdf", loaderKind: "pdf", mimeType: "application/pdf" },
    doc: {
        fileType: "doc",
        loaderKind: "docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    sheet: {
        fileType: "sheet",
        loaderKind: "sheet",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    ppt: {
        fileType: "ppt",
        loaderKind: "pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    image: { fileType: "image", loaderKind: "image", mimeType: "application/octet-stream" },
    json: { fileType: "json", loaderKind: "json", mimeType: "application/json" },
    text: { fileType: "text", loaderKind: "text", mimeType: "text/plain" },
};

const PDF_HEADER = encodeASCII("%PDF-");
const PNG_HEADER = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG_HEADER = Uint8Array.of(0xff, 0xd8, 0xff);
const GIF87A_HEADER = encodeASCII("GIF87a");
const GIF89A_HEADER = encodeASCII("GIF89a");
const WEBP_RIFF_HEADER = encodeASCII("RIFF");
const WEBP_BRAND = encodeASCII("WEBP");
const BMP_HEADER = encodeASCII("BM");
const TIFF_LE_HEADER = Uint8Array.of(0x49, 0x49, 0x2a, 0x00);
const TIFF_BE_HEADER = Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a);
const ZIP_HEADERS = [
    Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
    Uint8Array.of(0x50, 0x4b, 0x05, 0x06),
    Uint8Array.of(0x50, 0x4b, 0x07, 0x08),
];
const OOXML_WORD_ENTRY = encodeASCII("word/document.xml");
const OOXML_PRESENTATION_ENTRY = encodeASCII("ppt/presentation.xml");
const OOXML_WORKBOOK_ENTRY = encodeASCII("xl/workbook.xml");

export class BufferedGraphBinaryLoader implements GraphBinaryLoader {
    private text?: string;

    constructor(private readonly content: ArrayBuffer) {}

    async getText(): Promise<string> {
        this.text ??= new TextDecoder().decode(this.content);
        return this.text;
    }

    async getBinary(): Promise<ArrayBuffer> {
        return this.content;
    }
}

export function detectGraphFileFormat(input: {
    content: ArrayBuffer;
    declaredType: GraphFileType;
    mimeType?: string | null;
}): DetectedGraphFileFormat {
    const bytes = new Uint8Array(input.content);
    const sniffed = sniffGraphFileFormat(bytes);
    if (sniffed) {
        return { ...sniffed, sniffed: true };
    }

    const fallback = DEFAULT_FILE_FORMATS[input.declaredType] ?? DEFAULT_FILE_FORMATS.text;
    return {
        ...fallback,
        mimeType: normalizeMimeType(input.mimeType) ?? fallback.mimeType,
        sniffed: false,
    };
}

export function createDetectedGraphLoader(input: {
    content: ArrayBuffer;
    declaredType: GraphFileType;
    mimeType?: string | null;
    documentMode?: PDFMode;
    imageModel?: LanguageModelV3;
    derivedImageStorage?: { bucket: string; imagePrefix: string };
}): {
    format: DetectedGraphFileFormat;
    loader: GraphLoader;
    binaryLoader: BufferedGraphBinaryLoader;
} {
    const binaryLoader = new BufferedGraphBinaryLoader(input.content);
    const format = detectGraphFileFormat(input);
    const documentMode = input.documentMode ?? "hybrid";
    const useDocumentOCR = documentMode !== "plain";

    switch (format.loaderKind) {
        case "pdf":
            return {
                format,
                loader: new PDFLoader(buildPDFLoaderOptions(binaryLoader, input.imageModel, input.derivedImageStorage, documentMode)),
                binaryLoader,
            };
        case "docx":
            return {
                format,
                loader: useDocumentOCR
                    ? new DOCXLoader({
                          ocr: true,
                          loader: binaryLoader,
                          model: requireImageModel(input.imageModel, "Document OCR"),
                          storage: requireDerivedImageStorage(input.derivedImageStorage, "Document OCR"),
                      })
                    : new DOCXLoader({ loader: binaryLoader }),
                binaryLoader,
            };
        case "sheet":
            return {
                format,
                loader: new ExcelLoader({ loader: binaryLoader }),
                binaryLoader,
            };
        case "pptx":
            return {
                format,
                loader: useDocumentOCR
                    ? new PPTXLoader({
                          ocr: true,
                          loader: binaryLoader,
                          model: requireImageModel(input.imageModel, "Presentation OCR"),
                          storage: requireDerivedImageStorage(input.derivedImageStorage, "Presentation OCR"),
                      })
                    : new PPTXLoader({ loader: binaryLoader }),
                binaryLoader,
            };
        case "image":
            return {
                format,
                loader: new ImageLoader({
                    loader: binaryLoader,
                    model: requireImageModel(input.imageModel, "Image extraction"),
                }),
                binaryLoader,
            };
        case "json":
        case "text":
        default:
            return {
                format,
                loader: binaryLoader,
                binaryLoader,
            };
    }
}

function buildPDFLoaderOptions(
    loader: GraphBinaryLoader,
    model: LanguageModelV3 | undefined,
    storage: { bucket: string; imagePrefix: string } | undefined,
    mode: PDFMode
): ConstructorParameters<typeof PDFLoader>[0] {
    const options: ConstructorParameters<typeof PDFLoader>[0] = { loader, mode };
    if (mode === "plain") {
        return options;
    }

    options.model = requireImageModel(model, `PDF ${mode}`);
    if (storage) {
        options.storage = storage;
    }

    return options;
}

function requireImageModel(model: LanguageModelV3 | undefined, context: string): LanguageModelV3 {
    if (!model) {
        throw new Error(`${context} requires an image-capable model`);
    }

    return model;
}

function requireDerivedImageStorage(
    storage: { bucket: string; imagePrefix: string } | undefined,
    context: string
): { bucket: string; imagePrefix: string } {
    if (!storage) {
        throw new Error(`${context} requires derived image storage`);
    }

    return storage;
}

function sniffGraphFileFormat(bytes: Uint8Array): Omit<DetectedGraphFileFormat, "sniffed"> | null {
    if (hasPDFSignature(bytes)) {
        return DEFAULT_FILE_FORMATS.pdf;
    }

    const imageMimeType = sniffImageMimeType(bytes);
    if (imageMimeType) {
        return {
            ...DEFAULT_FILE_FORMATS.image,
            mimeType: imageMimeType,
        };
    }

    if (!hasZipSignature(bytes)) {
        return null;
    }

    if (containsASCII(bytes, OOXML_WORD_ENTRY)) {
        return DEFAULT_FILE_FORMATS.doc;
    }

    if (containsASCII(bytes, OOXML_PRESENTATION_ENTRY)) {
        return DEFAULT_FILE_FORMATS.ppt;
    }

    if (containsASCII(bytes, OOXML_WORKBOOK_ENTRY)) {
        return DEFAULT_FILE_FORMATS.sheet;
    }

    return null;
}

function hasPDFSignature(bytes: Uint8Array): boolean {
    const limit = Math.min(bytes.length - PDF_HEADER.length, 1024);
    for (let index = 0; index <= limit; index += 1) {
        if (matchesAt(bytes, PDF_HEADER, index)) {
            return true;
        }
    }

    return false;
}

function sniffImageMimeType(bytes: Uint8Array): string | null {
    if (matchesAt(bytes, PNG_HEADER, 0)) {
        return "image/png";
    }

    if (matchesAt(bytes, JPEG_HEADER, 0)) {
        return "image/jpeg";
    }

    if (matchesAt(bytes, GIF87A_HEADER, 0) || matchesAt(bytes, GIF89A_HEADER, 0)) {
        return "image/gif";
    }

    if (matchesAt(bytes, BMP_HEADER, 0)) {
        return "image/bmp";
    }

    if (matchesAt(bytes, TIFF_LE_HEADER, 0) || matchesAt(bytes, TIFF_BE_HEADER, 0)) {
        return "image/tiff";
    }

    if (matchesAt(bytes, WEBP_RIFF_HEADER, 0) && matchesAt(bytes, WEBP_BRAND, 8)) {
        return "image/webp";
    }

    return null;
}

function hasZipSignature(bytes: Uint8Array): boolean {
    return ZIP_HEADERS.some((header) => matchesAt(bytes, header, 0));
}

function containsASCII(bytes: Uint8Array, needle: Uint8Array): boolean {
    if (needle.length === 0 || bytes.length < needle.length) {
        return false;
    }

    const maxStart = bytes.length - needle.length;
    for (let index = 0; index <= maxStart; index += 1) {
        if (bytes[index] !== needle[0]) {
            continue;
        }

        if (matchesAt(bytes, needle, index)) {
            return true;
        }
    }

    return false;
}

function matchesAt(bytes: Uint8Array, needle: Uint8Array, start: number): boolean {
    if (start < 0 || start + needle.length > bytes.length) {
        return false;
    }

    for (let index = 0; index < needle.length; index += 1) {
        if (bytes[start + index] !== needle[index]) {
            return false;
        }
    }

    return true;
}

function normalizeMimeType(value?: string | null): string | null {
    const normalized = value?.trim().toLowerCase();
    return normalized ? normalized.split(";")[0]?.trim() ?? null : null;
}

function encodeASCII(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}
