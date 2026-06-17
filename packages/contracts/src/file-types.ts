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
    "text",
] as const;

export type FileTypeValue = (typeof FILE_TYPE_VALUES)[number];

export const FILE_TYPE_CHUNK_SIZE_MIN = 50;
export const FILE_TYPE_CHUNK_SIZE_MAX = 100_000;

export const FILE_TYPE_DOCUMENT_MODE_VALUES = ["plain", "hybrid", "ocr"] as const;

export type FileTypeDocumentMode = (typeof FILE_TYPE_DOCUMENT_MODE_VALUES)[number];
