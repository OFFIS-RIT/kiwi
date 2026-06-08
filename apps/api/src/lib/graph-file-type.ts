export type GraphFileType =
    | "pdf"
    | "doc"
    | "sheet"
    | "ppt"
    | "image"
    | "audio"
    | "video"
    | "html"
    | "email"
    | "calendar"
    | "vcard"
    | "json"
    | "xml"
    | "yaml"
    | "toml"
    | "text";

export function inferGraphFileType(file: File): GraphFileType {
    const normalizedMimeType = file.type?.trim().toLowerCase() ?? "";
    const rawExtension = file.name.split(".").pop()?.trim().toLowerCase();
    const extension = rawExtension && rawExtension !== file.name.toLowerCase() ? rawExtension : "";

    if (normalizedMimeType === "application/pdf" || extension === "pdf") {
        return "pdf";
    }

    if (
        normalizedMimeType === "application/msword" ||
        normalizedMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        extension === "doc" ||
        extension === "docx"
    ) {
        return "doc";
    }

    if (
        normalizedMimeType === "application/vnd.ms-excel" ||
        normalizedMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        normalizedMimeType === "text/csv" ||
        extension === "xls" ||
        extension === "xlsx" ||
        extension === "csv"
    ) {
        return "sheet";
    }

    if (
        normalizedMimeType === "application/vnd.ms-powerpoint" ||
        normalizedMimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
        extension === "ppt" ||
        extension === "pptx"
    ) {
        return "ppt";
    }

    if (normalizedMimeType.startsWith("image/")) {
        return "image";
    }

    if (
        normalizedMimeType.startsWith("audio/") ||
        ["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "mpga"].includes(extension)
    ) {
        return "audio";
    }

    if (
        normalizedMimeType.startsWith("video/") ||
        ["mp4", "m4v", "mov", "mkv", "webm", "avi"].includes(extension)
    ) {
        return "video";
    }

    if (
        normalizedMimeType === "text/html" ||
        normalizedMimeType === "application/xhtml+xml" ||
        extension === "html" ||
        extension === "htm" ||
        extension === "xhtml"
    ) {
        return "html";
    }

    if (
        normalizedMimeType === "message/rfc822" ||
        normalizedMimeType === "application/vnd.ms-outlook" ||
        normalizedMimeType === "application/mbox" ||
        extension === "eml" ||
        extension === "msg" ||
        extension === "mbox"
    ) {
        return "email";
    }

    if (
        normalizedMimeType === "text/calendar" ||
        normalizedMimeType === "application/ics" ||
        extension === "ics" ||
        extension === "ical" ||
        extension === "ifb"
    ) {
        return "calendar";
    }

    if (
        normalizedMimeType === "text/vcard" ||
        normalizedMimeType === "text/x-vcard" ||
        normalizedMimeType === "text/directory" ||
        extension === "vcf" ||
        extension === "vcard"
    ) {
        return "vcard";
    }

    if (normalizedMimeType === "application/json" || extension === "json") {
        return "json";
    }

    if (
        normalizedMimeType === "application/xml" ||
        normalizedMimeType === "text/xml" ||
        normalizedMimeType.endsWith("+xml") ||
        extension === "xml" ||
        extension === "xsd" ||
        extension === "xsl"
    ) {
        return "xml";
    }

    if (
        normalizedMimeType === "application/yaml" ||
        normalizedMimeType === "application/x-yaml" ||
        normalizedMimeType === "text/yaml" ||
        normalizedMimeType === "text/x-yaml" ||
        extension === "yaml" ||
        extension === "yml"
    ) {
        return "yaml";
    }

    if (normalizedMimeType === "application/toml" || normalizedMimeType === "text/toml" || extension === "toml") {
        return "toml";
    }

    return "text";
}
