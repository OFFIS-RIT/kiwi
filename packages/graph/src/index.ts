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
};

export type Unit = {
    id: string;
    fileId: string;
    content: string;
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

export interface GraphBinaryLoader extends GraphLoader {
    getBinary: () => Promise<ArrayBuffer>;
}

export interface GraphChunker {
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
export { JSONChunker } from "./chunking/json";
export { SemanticChunker } from "./chunking/semantic";
export { SingleChunker } from "./chunking/single";
