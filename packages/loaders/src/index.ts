import type { LoadedGraphDocument } from "@kiwi/contracts/source";

export type { LoadedGraphDocument, LoaderSourceChunk, SourceChunkRegion, TextUnitSourceChunk } from "@kiwi/contracts/source";

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
