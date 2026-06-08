import type { LoadedGraphDocument, TextUnitSourceChunk } from "@kiwi/contracts/source";

export type Entity = {
    id: string;
    name: string;
    type: string;
    description?: string;
    sources: Source[];
};

export type Relationship = {
    id: string;
    sourceId: string;
    targetId: string;
    strength: number;
    description?: string;
    sources: Source[];
};

export type Source = {
    id: string;
    unitId: string;
    description: string;
    sourceChunkIds?: number[];
};

export type {
    LoadedGraphDocument,
    LoaderSourceChunk,
    SourceChunkRegion,
    TextUnitSourceChunk,
} from "@kiwi/contracts/source";
export { isLoaderSourceChunk, isSourceChunkRegion, isTextUnitSourceChunk } from "@kiwi/contracts/source";

export type Unit = {
    id: string;
    fileId: string;
    content: string;
    startPage: number | null;
    endPage: number | null;
    chunks: TextUnitSourceChunk[];
};

export type Graph = {
    id: string;
    units: Unit[];
    entities: Entity[];
    relationships: Relationship[];
};

export interface GraphLoader {
    getText: () => Promise<string>;
}

export interface GraphDocumentLoader extends GraphLoader {
    getDocument: () => Promise<LoadedGraphDocument>;
}

export interface GraphBinaryLoader extends GraphLoader {
    getBinary: () => Promise<ArrayBuffer>;
}

export type GraphTextChunk = {
    content: string;
    startOffset: number;
    endOffset: number;
};

export interface GraphChunker {
    getChunkSpans: (content: string) => Promise<GraphTextChunk[]>;
    getChunks: (content: string) => Promise<string[]>;
}

export type GraphFile = {
    id: string;
    key: string;
    filename: string;
    filetype: string;
    chunker: GraphChunker;
    loader: GraphLoader;
};

export { CSVChunker } from "./chunking/csv";
export { CalendarChunker } from "./chunking/calendar";
export { EmailChunker } from "./chunking/email";
export { HTMLChunker } from "./chunking/html";
export { JSONChunker } from "./chunking/json";
export { SemanticChunker } from "./chunking/semantic";
export { SingleChunker } from "./chunking/single";
export { TOMLChunker } from "./chunking/toml";
export { TranscriptChunker } from "./chunking/transcript";
export { VCardChunker } from "./chunking/vcard";
export { XMLChunker } from "./chunking/xml";
export { YAMLChunker } from "./chunking/yaml";
