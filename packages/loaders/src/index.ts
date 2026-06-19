import type * as Effect from "effect/Effect";
import type { LoadedGraphDocument } from "@kiwi/contracts/source";

export type {
    LoadedGraphDocument,
    LoaderSourceChunk,
    SourceChunkRegion,
    TextUnitSourceChunk,
} from "@kiwi/contracts/source";

export interface GraphLoader {
    getText: () => Promise<string>;
    getTextEffect?: () => Effect.Effect<string, unknown>;
}

export interface GraphDocumentLoader extends GraphLoader {
    getDocument: () => Promise<LoadedGraphDocument>;
    getDocumentEffect?: () => Effect.Effect<LoadedGraphDocument, unknown>;
}

export interface GraphBinaryLoader extends GraphLoader {
    getBinary: () => Promise<ArrayBuffer>;
    getBinaryEffect?: () => Effect.Effect<ArrayBuffer, unknown>;
}

export type GraphTextChunk = {
    content: string;
    startOffset: number;
    endOffset: number;
};

export interface GraphChunker {
    getChunkSpans: (content: string) => Promise<GraphTextChunk[]>;
    getChunkSpansEffect?: (content: string) => Effect.Effect<GraphTextChunk[], unknown>;
    getChunks: (content: string) => Promise<string[]>;
    getChunksEffect?: (content: string) => Effect.Effect<string[], unknown>;
}
