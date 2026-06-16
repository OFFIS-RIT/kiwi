export type XMLNodeLike = {
    nodeType?: number;
    nodeName?: string | null;
    localName?: string | null;
    textContent?: string | null;
    childNodes?: ArrayLike<unknown>;
    getAttribute?: (name: string) => string | null;
};

export type XMLDocumentLike = {
    documentElement?: unknown;
};

export type ContentTypes = {
    defaults: Map<string, string>;
    overrides: Map<string, string>;
};

export type RelationshipTarget = {
    target: string;
    external: boolean;
    type: string | null;
};

export type Relationships = Map<string, RelationshipTarget>;
