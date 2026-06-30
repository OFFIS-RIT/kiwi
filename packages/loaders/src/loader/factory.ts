import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { FILE_TYPE_DOCUMENT_MODE_VALUES, type FileTypeDocumentMode } from "@kiwi/contracts/file-types";
import type { GraphBinaryLoader, GraphLoader } from "../types";
import type { GraphFileType } from "../file-type";
import { AudioLoader } from "./audio";
import { CalendarLoader } from "./calendar";
import { CSVLoader } from "./csv";
import { DOCXLoader } from "./doc";
import { EmailLoader, inferEmailFormat, isMboxSeparator } from "./email";
import { ExcelLoader } from "./excel";
import { HTMLLoader, type HTMLLoaderMode } from "./html";
import { ImageLoader } from "./image";
import { PDFLoader, type PDFMode } from "./pdf";
import { PPTXLoader } from "./ppt";
import { VCardLoader } from "./vcard";
import { VideoLoader } from "./video";
import { XMLLoader } from "./xml";

export type { GraphFileType } from "../file-type";

export type GraphLoaderKind =
    | "pdf"
    | "docx"
    | "sheet"
    | "pptx"
    | "image"
    | "audio"
    | "video"
    | "html"
    | "email"
    | "calendar"
    | "vcard"
    | "json"
    | "csv"
    | "xml"
    | "text";

export type DetectedGraphFileFormat = {
    fileType: GraphFileType;
    loaderKind: GraphLoaderKind;
    mimeType: string;
    sniffed: boolean;
};

export const GRAPH_DOCUMENT_MODES = FILE_TYPE_DOCUMENT_MODE_VALUES;
export type GraphDocumentMode = FileTypeDocumentMode;

const graphDocumentModeSet = new Set<string>(GRAPH_DOCUMENT_MODES);

export function isGraphDocumentMode(value: unknown): value is GraphDocumentMode {
    return typeof value === "string" && graphDocumentModeSet.has(value);
}

export const DEFAULT_DOCUMENT_MODES: Record<GraphFileType, GraphDocumentMode | null> = {
    pdf: "hybrid",
    doc: "hybrid",
    sheet: null,
    ppt: "hybrid",
    image: null,
    audio: null,
    video: null,
    html: null,
    email: null,
    calendar: null,
    vcard: null,
    json: null,
    jsonl: null,
    jsonc: null,
    csv: null,
    xml: null,
    yaml: null,
    toml: null,
    code: null,
    text: null,
};

export const DEFAULT_FILE_FORMATS: Record<GraphFileType, Omit<DetectedGraphFileFormat, "sniffed">> = {
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
    audio: { fileType: "audio", loaderKind: "audio", mimeType: "application/octet-stream" },
    video: { fileType: "video", loaderKind: "video", mimeType: "application/octet-stream" },
    html: { fileType: "html", loaderKind: "html", mimeType: "text/html" },
    email: { fileType: "email", loaderKind: "email", mimeType: "message/rfc822" },
    calendar: { fileType: "calendar", loaderKind: "calendar", mimeType: "text/calendar" },
    vcard: { fileType: "vcard", loaderKind: "vcard", mimeType: "text/vcard" },
    json: { fileType: "json", loaderKind: "json", mimeType: "application/json" },
    jsonl: { fileType: "jsonl", loaderKind: "json", mimeType: "application/x-ndjson" },
    jsonc: { fileType: "jsonc", loaderKind: "json", mimeType: "application/jsonc" },
    csv: { fileType: "csv", loaderKind: "csv", mimeType: "text/csv" },
    xml: { fileType: "xml", loaderKind: "xml", mimeType: "application/xml" },
    yaml: { fileType: "yaml", loaderKind: "text", mimeType: "application/yaml" },
    toml: { fileType: "toml", loaderKind: "text", mimeType: "application/toml" },
    code: { fileType: "code", loaderKind: "text", mimeType: "text/plain" },
    text: { fileType: "text", loaderKind: "text", mimeType: "text/plain" },
};

const PDF_HEADER = encodeASCII("%PDF-");
const PNG_HEADER = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG_HEADER = Uint8Array.of(0xff, 0xd8, 0xff);
const GIF87A_HEADER = encodeASCII("GIF87a");
const GIF89A_HEADER = encodeASCII("GIF89a");
const WEBP_RIFF_HEADER = encodeASCII("RIFF");
const WEBP_BRAND = encodeASCII("WEBP");
const AVI_BRAND = encodeASCII("AVI ");
const BMP_HEADER = encodeASCII("BM");
const TIFF_LE_HEADER = Uint8Array.of(0x49, 0x49, 0x2a, 0x00);
const TIFF_BE_HEADER = Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a);
const OLE_COMPOUND_HEADER = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const EBML_HEADER = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
const MP4_FTYP_MARKER = encodeASCII("ftyp");
const ZIP_HEADERS = [
    Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
    Uint8Array.of(0x50, 0x4b, 0x05, 0x06),
    Uint8Array.of(0x50, 0x4b, 0x07, 0x08),
];
const OOXML_WORD_ENTRY = encodeASCII("word/document.xml");
const OOXML_PRESENTATION_ENTRY = encodeASCII("ppt/presentation.xml");
const OOXML_WORKBOOK_ENTRY = encodeASCII("xl/workbook.xml");
const EMAIL_HEADER_NAMES = new Set(["bcc", "cc", "date", "from", "message-id", "reply-to", "subject", "to"]);
const EMAIL_ROUTE_HEADER_NAMES = new Set(["bcc", "cc", "from", "message-id", "reply-to", "to"]);

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
    const sniffed = sniffGraphFileFormat(bytes, input.declaredType);
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

export function detectGraphLoaderFileFormat(input: {
    content: ArrayBuffer;
    declaredType: GraphFileType;
    mimeType?: string | null;
    audioModel?: TranscriptionModelV4;
    videoModel?: TranscriptionModelV4;
}): DetectedGraphFileFormat {
    const format = detectGraphFileFormat(input);
    if (shouldUseVideoFallbackForAudioWebM(input, format)) {
        return {
            ...DEFAULT_FILE_FORMATS.video,
            mimeType: "video/webm",
            sniffed: true,
        };
    }

    return format;
}

export function createDetectedGraphLoader(input: {
    content: ArrayBuffer;
    declaredType: GraphFileType;
    mimeType?: string | null;
    format?: DetectedGraphFileFormat;
    documentMode?: PDFMode;
    htmlMode?: HTMLLoaderMode;
    imageModel?: LanguageModel;
    audioModel?: TranscriptionModelV4;
    videoModel?: TranscriptionModelV4;
    derivedImageStorage?: { bucket: string; imagePrefix: string };
}): {
    format: DetectedGraphFileFormat;
    loader: GraphLoader;
    binaryLoader: BufferedGraphBinaryLoader;
} {
    const binaryLoader = new BufferedGraphBinaryLoader(input.content);
    const format = input.format ?? detectGraphLoaderFileFormat(input);
    const documentMode = input.documentMode ?? "hybrid";
    const useDocumentOCR = documentMode !== "plain";
    const bytes = new Uint8Array(input.content);
    if (hasOLECompoundSignature(bytes) && ["docx", "pptx"].includes(format.loaderKind)) {
        throw new Error("Unsupported file type: legacy Office documents are not supported");
    }

    if (format.loaderKind === "csv" && looksLikeBinary(bytes)) {
        throw new Error("Invalid CSV content: binary files are not valid CSV");
    }

    if (format.loaderKind === "json" && looksLikeBinary(bytes)) {
        throw new Error("Invalid JSON content: binary files are not valid JSON");
    }

    if (format.loaderKind === "text" && looksLikeBinary(bytes)) {
        throw new Error("Unsupported file type: binary files are not supported");
    }

    switch (format.loaderKind) {
        case "pdf":
            return {
                format,
                loader: new PDFLoader(
                    buildPDFLoaderOptions(binaryLoader, input.imageModel, input.derivedImageStorage, documentMode)
                ),
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
        case "csv":
            return {
                format,
                loader: new CSVLoader({ loader: binaryLoader }),
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
        case "audio":
            return {
                format,
                loader: new AudioLoader({
                    loader: binaryLoader,
                    model: requireAudioModel(input.audioModel, "Audio transcription"),
                    mimeType: format.mimeType,
                }),
                binaryLoader,
            };
        case "video":
            return {
                format,
                loader: new VideoLoader({
                    loader: binaryLoader,
                    model: requireVideoModel(input.videoModel, "Video transcription"),
                    mimeType: format.mimeType,
                }),
                binaryLoader,
            };
        case "html":
            return {
                format,
                loader: new HTMLLoader({ loader: binaryLoader, mode: input.htmlMode ?? "content" }),
                binaryLoader,
            };
        case "xml":
            return {
                format,
                loader: new XMLLoader({ loader: binaryLoader }),
                binaryLoader,
            };
        case "email":
            return {
                format,
                loader: new EmailLoader({
                    loader: binaryLoader,
                    format: inferEmailFormat(format.mimeType, input.content),
                    mimeType: format.mimeType,
                }),
                binaryLoader,
            };
        case "calendar":
            return {
                format,
                loader: new CalendarLoader({ loader: binaryLoader }),
                binaryLoader,
            };
        case "vcard":
            return {
                format,
                loader: new VCardLoader({ loader: binaryLoader }),
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

function shouldUseVideoFallbackForAudioWebM(
    input: {
        declaredType: GraphFileType;
        audioModel?: TranscriptionModelV4;
        videoModel?: TranscriptionModelV4;
    },
    format: DetectedGraphFileFormat
): boolean {
    return (
        input.declaredType === "video" &&
        format.fileType === "audio" &&
        format.mimeType === "audio/webm" &&
        !input.audioModel &&
        Boolean(input.videoModel)
    );
}

function buildPDFLoaderOptions(
    loader: GraphBinaryLoader,
    model: LanguageModel | undefined,
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

function requireImageModel(model: LanguageModel | undefined, context: string): LanguageModel {
    if (!model) {
        throw new Error(`${context} requires an image-capable model`);
    }

    return model;
}

function requireAudioModel(model: TranscriptionModelV4 | undefined, context: string): TranscriptionModelV4 {
    if (!model) {
        throw new Error(`${context} requires an audio transcription model`);
    }

    return model;
}

function requireVideoModel(model: TranscriptionModelV4 | undefined, context: string): TranscriptionModelV4 {
    if (!model) {
        throw new Error(`${context} requires a video transcription model`);
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

function sniffGraphFileFormat(
    bytes: Uint8Array,
    declaredType: GraphFileType
): Omit<DetectedGraphFileFormat, "sniffed"> | null {
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

    const ebmlMimeType = sniffEBMLMimeType(bytes);
    if (ebmlMimeType === "audio/webm") {
        return {
            ...DEFAULT_FILE_FORMATS.audio,
            mimeType: ebmlMimeType,
        };
    }

    if (declaredType !== "audio" && ebmlMimeType === "video/webm") {
        return {
            ...DEFAULT_FILE_FORMATS.video,
            mimeType: ebmlMimeType,
        };
    }

    const videoMimeType = declaredType === "audio" ? null : sniffVideoMimeType(bytes);
    if (videoMimeType) {
        return {
            ...DEFAULT_FILE_FORMATS.video,
            mimeType: videoMimeType,
        };
    }

    const textFormat = sniffTextFileFormat(bytes, declaredType);
    if (textFormat) {
        return textFormat;
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

function sniffTextFileFormat(
    bytes: Uint8Array,
    declaredType: GraphFileType
): Omit<DetectedGraphFileFormat, "sniffed"> | null {
    const prefix = new TextDecoder().decode(bytes.slice(0, 4096)).trimStart();
    const lowerPrefix = prefix.toLowerCase();

    if (lowerPrefix.startsWith("<!doctype html") || lowerPrefix.startsWith("<html")) {
        return DEFAULT_FILE_FORMATS.html;
    }

    if (lowerPrefix.startsWith("begin:vcalendar")) {
        return DEFAULT_FILE_FORMATS.calendar;
    }

    if (lowerPrefix.startsWith("begin:vcard")) {
        return DEFAULT_FILE_FORMATS.vcard;
    }

    if (declaredType === "email" && matchesAt(bytes, Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0), 0)) {
        return {
            ...DEFAULT_FILE_FORMATS.email,
            mimeType: "application/vnd.ms-outlook",
        };
    }

    if (declaredType === "email" && isMboxSeparator(prefix.split(/\r?\n/u)[0] ?? "")) {
        return {
            ...DEFAULT_FILE_FORMATS.email,
            mimeType: "application/mbox",
        };
    }

    if (declaredType === "text" && hasEmailHeaderBlock(prefix)) {
        return DEFAULT_FILE_FORMATS.email;
    }

    return null;
}

function hasEmailHeaderBlock(prefix: string): boolean {
    const headers = new Set<string>();
    let hasRouteHeader = false;

    for (const line of prefix.split(/\r?\n/u)) {
        if (line.trim() === "") {
            break;
        }

        if (/^[\t ]/u.test(line)) {
            continue;
        }

        const match = /^([a-z][a-z0-9-]*):/iu.exec(line);
        if (!match) {
            break;
        }

        const header = match[1]!.toLowerCase();
        if (EMAIL_HEADER_NAMES.has(header)) {
            headers.add(header);
            hasRouteHeader ||= EMAIL_ROUTE_HEADER_NAMES.has(header);
        }
    }

    return headers.size >= 2 && hasRouteHeader;
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

function sniffVideoMimeType(bytes: Uint8Array): string | null {
    if (matchesAt(bytes, WEBP_RIFF_HEADER, 0) && matchesAt(bytes, AVI_BRAND, 8)) {
        return "video/x-msvideo";
    }

    if (!matchesAt(bytes, MP4_FTYP_MARKER, 4) || bytes.length < 12) {
        return null;
    }

    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (brand === "qt  ") {
        return "video/quicktime";
    }

    if (["isom", "iso2", "avc1", "mp41", "mp42", "M4V ", "3gp4", "3gp5", "dash"].includes(brand)) {
        return "video/mp4";
    }

    return null;
}

function sniffEBMLMimeType(bytes: Uint8Array): "audio/webm" | "video/webm" | null {
    if (!matchesAt(bytes, EBML_HEADER, 0)) {
        return null;
    }

    const trackTypes = sniffEBMLTrackTypes(bytes);
    if (trackTypes.has(1)) {
        return "video/webm";
    }

    if (trackTypes.has(2)) {
        return "audio/webm";
    }

    return "video/webm";
}

function sniffEBMLTrackTypes(bytes: Uint8Array): Set<number> {
    const trackTypes = new Set<number>();
    const limit = Math.min(bytes.length, 65_536);

    for (let index = EBML_HEADER.length; index < limit - 2; index += 1) {
        if (bytes[index] !== 0x83) {
            continue;
        }

        const size = readEBMLVariableInteger(bytes, index + 1, limit);
        if (!size || size.value < 1 || size.value > 8) {
            continue;
        }

        const valueStart = index + 1 + size.length;
        const valueEnd = valueStart + size.value;
        if (valueEnd > limit) {
            continue;
        }

        const trackType = readUnsignedInteger(bytes, valueStart, valueEnd);
        if (trackType === 1 || trackType === 2) {
            trackTypes.add(trackType);
        }
    }

    return trackTypes;
}

function readEBMLVariableInteger(
    bytes: Uint8Array,
    start: number,
    limit: number
): { value: number; length: number } | null {
    const first = bytes[start];
    if (!first) {
        return null;
    }

    let mask = 0x80;
    let length = 1;
    while (length <= 8 && (first & mask) === 0) {
        mask >>= 1;
        length += 1;
    }

    if (length > 8 || start + length > limit) {
        return null;
    }

    let value = first & (mask - 1);
    for (let offset = 1; offset < length; offset += 1) {
        value = value * 256 + bytes[start + offset]!;
    }

    return { value, length };
}

function readUnsignedInteger(bytes: Uint8Array, start: number, end: number): number {
    let value = 0;
    for (let index = start; index < end; index += 1) {
        value = value * 256 + bytes[index]!;
    }

    return value;
}

function hasZipSignature(bytes: Uint8Array): boolean {
    return ZIP_HEADERS.some((header) => matchesAt(bytes, header, 0));
}

function hasOLECompoundSignature(bytes: Uint8Array): boolean {
    return matchesAt(bytes, OLE_COMPOUND_HEADER, 0);
}

function looksLikeBinary(bytes: Uint8Array): boolean {
    const sample = bytes.slice(0, Math.min(bytes.length, 4096));
    if (sample.length === 0) {
        return false;
    }

    let controlCharacterCount = 0;
    for (const byte of sample) {
        if (byte === 0) {
            return true;
        }

        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
            controlCharacterCount += 1;
        }
    }

    return controlCharacterCount / sample.length > 0.1;
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
    return normalized ? (normalized.split(";")[0]?.trim() ?? null) : null;
}

function encodeASCII(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}
