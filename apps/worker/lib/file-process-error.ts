import type { FileProcessErrorCode } from "@kiwi/contracts/routes";

const INTERNAL_SERVER_ERROR_CODE = "INTERNAL_SERVER_ERROR" satisfies FileProcessErrorCode;

export function classifyFileProcessError(error: unknown): FileProcessErrorCode {
    if (!(error instanceof Error)) {
        return INTERNAL_SERVER_ERROR_CODE;
    }

    const message = error.message.toLowerCase();
    if (message.includes("unsupported file type")) {
        return "UNSUPPORTED_FILE_TYPE";
    }

    if (message.includes("password") || message.includes("encrypted")) {
        return "PASSWORD_PROTECTED_FILE";
    }

    if (message.includes("no readable text") || message.includes("transcription produced no text")) {
        return "NO_READABLE_TEXT";
    }

    if (
        message.includes("requires an image-capable model") ||
        message.includes("requires an image model") ||
        message.includes("requires derived image storage") ||
        message.includes("requires an audio transcription model") ||
        message.includes("requires a video transcription model")
    ) {
        return "OCR_REQUIRED_UNAVAILABLE";
    }

    if (
        message.includes("invalid csv") ||
        message.includes("invalid excel workbook content") ||
        message.includes("invalid pdf") ||
        message.includes("failed to parse pdf") ||
        message.includes("can't find end of central directory") ||
        message.includes("corrupted zip") ||
        message.includes("invalid file format")
    ) {
        return "INVALID_FILE_FORMAT";
    }

    if (isFileTooLargeOrComplex(message)) {
        return "FILE_TOO_LARGE_OR_COMPLEX";
    }

    if (message.includes("failed to load file") && message.includes("from bucket")) {
        return "SOURCE_FILE_MISSING";
    }

    if (message.includes("no object generated") || message.includes("unsupported formula function")) {
        return "EXTRACTION_FAILED";
    }

    return INTERNAL_SERVER_ERROR_CODE;
}

function isFileTooLargeOrComplex(message: string): boolean {
    return (
        message.includes("file too large") ||
        message.includes("file is too large") ||
        message.includes("document too large") ||
        message.includes("document is too large") ||
        message.includes("file too complex") ||
        message.includes("document too complex") ||
        message.includes("file timeout") ||
        message.includes("document timeout") ||
        message.includes("context length") ||
        message.includes("out of memory") ||
        /too many (pages|rows|columns|cells|tokens|chunks|images|slides|worksheets)\b/u.test(message)
    );
}
