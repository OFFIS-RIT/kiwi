import { FILE_TYPE_VALUES, type FileTypeValue } from "@kiwi/contracts/file-types";
import { isSupportedCodePath } from "./code/file-path";

export const GRAPH_FILE_TYPES = FILE_TYPE_VALUES;
export type GraphFileType = FileTypeValue;

const graphFileTypeSet = new Set<string>(GRAPH_FILE_TYPES);

const IMAGE_EXTENSIONS: readonly string[] = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "tif",
    "tiff",
    "svg",
    "heic",
    "heif",
];
const AUDIO_EXTENSIONS: readonly string[] = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "mpga"];
const VIDEO_EXTENSIONS: readonly string[] = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ogv"];

export function isGraphFileType(value: unknown): value is GraphFileType {
    return typeof value === "string" && graphFileTypeSet.has(value);
}

export function coerceGraphFileType(value: unknown, fallback: GraphFileType = "text"): GraphFileType {
    return isGraphFileType(value) ? value : fallback;
}

export function inferGraphFileType(file: Pick<File, "name" | "type">): GraphFileType {
    const mimeType = file.type?.trim().toLowerCase() ?? "";
    const mimeParameterStart = mimeType.indexOf(";");
    const mime = mimeParameterStart === -1 ? mimeType : mimeType.slice(0, mimeParameterStart).trim();
    const name = file.name.trim().toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 && dot + 1 < name.length ? name.slice(dot + 1) : "";

    if (mime === "application/pdf" || ext === "pdf") {
        return "pdf";
    }

    if (
        mime === "application/msword" ||
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        ext === "doc" ||
        ext === "docx"
    ) {
        return "doc";
    }

    if (mime === "text/csv" || ext === "csv") {
        return "csv";
    }

    if (
        mime === "application/vnd.ms-excel" ||
        mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        ext === "xls" ||
        ext === "xlsx"
    ) {
        return "sheet";
    }

    if (
        mime === "application/vnd.ms-powerpoint" ||
        mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
        ext === "ppt" ||
        ext === "pptx"
    ) {
        return "ppt";
    }

    if (mime.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) {
        return "image";
    }

    if (mime.startsWith("audio/") || mime === "application/ogg" || AUDIO_EXTENSIONS.includes(ext)) {
        return "audio";
    }

    if (mime.startsWith("video/") || VIDEO_EXTENSIONS.includes(ext)) {
        return "video";
    }

    if (
        mime === "text/html" ||
        mime === "application/xhtml+xml" ||
        ext === "html" ||
        ext === "htm" ||
        ext === "xhtml"
    ) {
        return "html";
    }

    if (
        mime === "message/rfc822" ||
        mime === "application/vnd.ms-outlook" ||
        mime === "application/mbox" ||
        ext === "eml" ||
        ext === "msg" ||
        ext === "mbox"
    ) {
        return "email";
    }

    if (mime === "text/calendar" || mime === "application/ics" || ext === "ics" || ext === "ical" || ext === "ifb") {
        return "calendar";
    }

    if (
        mime === "text/vcard" ||
        mime === "text/x-vcard" ||
        mime === "text/directory" ||
        ext === "vcf" ||
        ext === "vcard"
    ) {
        return "vcard";
    }

    if (
        mime === "application/jsonl" ||
        mime === "application/x-ndjson" ||
        mime === "application/ndjson" ||
        mime === "application/json-lines" ||
        ext === "jsonl" ||
        ext === "ndjson"
    ) {
        return "jsonl";
    }

    if (mime === "application/jsonc" || mime === "text/jsonc" || ext === "jsonc") {
        return "jsonc";
    }

    if (mime === "application/json" || ext === "json") {
        return "json";
    }

    if (
        mime === "application/xml" ||
        mime === "text/xml" ||
        mime.endsWith("+xml") ||
        ext === "xml" ||
        ext === "xsd" ||
        ext === "xsl"
    ) {
        return "xml";
    }

    if (
        mime === "application/yaml" ||
        mime === "application/x-yaml" ||
        mime === "text/yaml" ||
        mime === "text/x-yaml" ||
        ext === "yaml" ||
        ext === "yml"
    ) {
        return "yaml";
    }

    if (mime === "application/toml" || mime === "text/toml" || ext === "toml") {
        return "toml";
    }

    if (isSupportedCodePath(name)) {
        return "code";
    }

    return "text";
}
