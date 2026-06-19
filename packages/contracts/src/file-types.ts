import type { ApiResponse } from "./errors";

export const FILE_TYPE_VALUES = [
    "pdf",
    "doc",
    "sheet",
    "ppt",
    "image",
    "audio",
    "video",
    "html",
    "email",
    "calendar",
    "vcard",
    "json",
    "jsonl",
    "jsonc",
    "csv",
    "xml",
    "yaml",
    "toml",
    "code",
    "text",
] as const;

export type FileTypeValue = (typeof FILE_TYPE_VALUES)[number];

export const FILE_TYPE_CHUNK_SIZE_MIN = 50;
export const FILE_TYPE_CHUNK_SIZE_MAX = 100_000;

export const FILE_TYPE_DOCUMENT_MODE_VALUES = ["plain", "hybrid", "ocr"] as const;

export type FileTypeDocumentMode = (typeof FILE_TYPE_DOCUMENT_MODE_VALUES)[number];

export type FileTypeConfigRecord = {
    file_type: FileTypeValue;
    loader: string;
    chunker: string;
    chunk_size: number | null;
    document_mode: FileTypeDocumentMode | null;
    chunk_size_editable: boolean;
    document_mode_editable: boolean;
};

export type FileTypeConfigPatchInput = {
    chunk_size?: number;
    document_mode?: FileTypeDocumentMode;
};

export type FileTypeConfigListResponse = ApiResponse<
    FileTypeConfigRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;

export type FileTypeConfigPatchResponse = ApiResponse<
    FileTypeConfigRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "FILE_TYPE_NOT_FOUND"
    | "INVALID_FILE_TYPE_CONFIG"
    | "NO_CHANGES"
    | "INTERNAL_SERVER_ERROR"
>;
