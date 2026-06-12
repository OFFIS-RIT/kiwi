import type { GraphChunker } from "..";
import type { GraphFileType } from "../file-type";
import { CalendarChunker } from "./calendar";
import { CSVChunker } from "./csv";
import { EmailChunker } from "./email";
import { JSONChunker } from "./json";
import { SemanticChunker } from "./semantic";
import { SingleChunker } from "./single";
import { TOMLChunker } from "./toml";
import { TranscriptChunker } from "./transcript";
import { VCardChunker } from "./vcard";
import { YAMLChunker } from "./yaml";

export const GRAPH_CHUNKER_KINDS = [
    "single",
    "transcript",
    "email",
    "calendar",
    "vcard",
    "json",
    "csv",
    "yaml",
    "toml",
    "semantic",
] as const;
export type GraphChunkerKind = (typeof GRAPH_CHUNKER_KINDS)[number];

const graphChunkerKindSet = new Set<string>(GRAPH_CHUNKER_KINDS);

export function isGraphChunkerKind(value: unknown): value is GraphChunkerKind {
    return typeof value === "string" && graphChunkerKindSet.has(value);
}

export type GraphChunkingConfig = {
    chunker: GraphChunkerKind;
    chunkSize: number | null;
};

export const DEFAULT_STRUCTURED_CHUNK_SIZE = 500;
export const DEFAULT_SEMANTIC_CHUNK_SIZE = 2000;

export const DEFAULT_FILE_TYPE_CHUNKING: Record<GraphFileType, GraphChunkingConfig> = {
    pdf: { chunker: "semantic", chunkSize: DEFAULT_SEMANTIC_CHUNK_SIZE },
    doc: { chunker: "semantic", chunkSize: DEFAULT_SEMANTIC_CHUNK_SIZE },
    sheet: { chunker: "semantic", chunkSize: DEFAULT_SEMANTIC_CHUNK_SIZE },
    ppt: { chunker: "semantic", chunkSize: DEFAULT_SEMANTIC_CHUNK_SIZE },
    image: { chunker: "single", chunkSize: null },
    audio: { chunker: "transcript", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    video: { chunker: "transcript", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    html: { chunker: "semantic", chunkSize: DEFAULT_SEMANTIC_CHUNK_SIZE },
    email: { chunker: "email", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    calendar: { chunker: "calendar", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    vcard: { chunker: "vcard", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    json: { chunker: "json", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    csv: { chunker: "csv", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    xml: { chunker: "semantic", chunkSize: DEFAULT_SEMANTIC_CHUNK_SIZE },
    yaml: { chunker: "yaml", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    toml: { chunker: "toml", chunkSize: DEFAULT_STRUCTURED_CHUNK_SIZE },
    text: { chunker: "semantic", chunkSize: DEFAULT_SEMANTIC_CHUNK_SIZE },
};

export function createGraphChunker(kind: GraphChunkerKind, chunkSize?: number | null): GraphChunker {
    const structuredChunkSize = chunkSize ?? DEFAULT_STRUCTURED_CHUNK_SIZE;

    switch (kind) {
        case "single":
            return new SingleChunker();
        case "transcript":
            return new TranscriptChunker({ maxChunkSize: structuredChunkSize });
        case "email":
            return new EmailChunker({ maxChunkSize: structuredChunkSize });
        case "calendar":
            return new CalendarChunker({ maxChunkSize: structuredChunkSize });
        case "vcard":
            return new VCardChunker({ maxChunkSize: structuredChunkSize });
        case "json":
            return new JSONChunker({ maxChunkSize: structuredChunkSize });
        case "csv":
            return new CSVChunker({ maxChunkSize: structuredChunkSize });
        case "yaml":
            return new YAMLChunker({ maxChunkSize: structuredChunkSize });
        case "toml":
            return new TOMLChunker({ maxChunkSize: structuredChunkSize });
        case "semantic":
            return new SemanticChunker(chunkSize ?? DEFAULT_SEMANTIC_CHUNK_SIZE);
    }
}
