export type ByteRange = {
    start: number;
    end: number;
};

export function parseByteRange(value: string | null, size: number): ByteRange | "invalid" | null {
    if (!value) {
        return null;
    }

    if (size <= 0) {
        return "invalid";
    }

    const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
    if (!match) {
        return "invalid";
    }

    const startValue = match[1] ?? "";
    const endValue = match[2] ?? "";

    if (startValue === "" && endValue === "") {
        return "invalid";
    }

    if (startValue === "") {
        const suffixLength = Number(endValue);
        if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
            return "invalid";
        }

        return {
            start: Math.max(size - suffixLength, 0),
            end: size - 1,
        };
    }

    const start = Number(startValue);
    const requestedEnd = endValue === "" ? size - 1 : Number(endValue);
    if (
        !Number.isInteger(start) ||
        !Number.isInteger(requestedEnd) ||
        start < 0 ||
        requestedEnd < start ||
        start >= size
    ) {
        return "invalid";
    }

    return {
        start,
        end: Math.min(requestedEnd, size - 1),
    };
}

export function contentDispositionForFile(filename: string, mimeType: string): "inline" | "attachment" {
    const normalizedMimeType = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";

    if (normalizedMimeType === "application/pdf") {
        return "inline";
    }

    if (normalizedMimeType.startsWith("image/") && normalizedMimeType !== "image/svg+xml") {
        return "inline";
    }

    if (normalizedMimeType.startsWith("audio/") || normalizedMimeType.startsWith("video/")) {
        return "inline";
    }

    if (
        normalizedMimeType === "application/json" ||
        normalizedMimeType === "text/plain" ||
        normalizedMimeType === "text/markdown" ||
        normalizedMimeType === "text/x-markdown" ||
        normalizedMimeType === "text/csv"
    ) {
        return "inline";
    }

    if (extension === "txt" || extension === "md" || extension === "markdown" || extension === "json") {
        return "inline";
    }

    return "attachment";
}

export function contentDispositionHeader(filename: string, disposition: "inline" | "attachment"): string {
    const encodedFilename = encodeRFC5987HeaderValue(filename);

    return `${disposition}; filename="${escapeHeaderValue(filename)}"; filename*=UTF-8''${encodedFilename}`;
}

export function escapeHeaderValue(value: string): string {
    return value.replace(/["\\\r\n]/g, "_");
}

function encodeRFC5987HeaderValue(value: string): string {
    return encodeURIComponent(value).replace(/['()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
}
