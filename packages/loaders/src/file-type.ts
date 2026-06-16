export const GRAPH_FILE_TYPES = [
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

export type GraphFileType = (typeof GRAPH_FILE_TYPES)[number];
