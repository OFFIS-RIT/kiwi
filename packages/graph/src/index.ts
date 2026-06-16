import type { TextUnitSourceChunk } from "@kiwi/contracts/source";
import type { GraphChunker, GraphLoader } from "@kiwi/loaders";

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
    kind?: string;
    directed?: boolean;
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
export type { GraphBinaryLoader, GraphChunker, GraphDocumentLoader, GraphLoader, GraphTextChunk } from "@kiwi/loaders";

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

export type GraphFile = {
    id: string;
    key: string;
    filename: string;
    filetype: string;
    chunker: GraphChunker;
    loader: GraphLoader;
};
