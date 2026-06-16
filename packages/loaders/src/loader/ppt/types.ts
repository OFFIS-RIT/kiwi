import type JSZip from "jszip";
import type { ContentTypes, Relationships } from "../ooxml/types";

export type PPTOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

export type ParsedPPT = {
    slides: SlideContent[];
    images: PPTOCRImage[];
};

export type SlideContent = {
    index: number;
    hasTitle: boolean;
    blocks: SlideBlock[];
};

export type SlideBlock =
    | { kind: "heading"; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "bullet"; text: string; level: number; ordered: boolean }
    | { kind: "table"; rows: string[][]; hasHeader: boolean }
    | { kind: "image"; id: string };

export type PPTParseContext = {
    zip: JSZip;
    presentationRelationships: Relationships;
    relationships: Relationships;
    relationshipsByPart: Map<string, Relationships>;
    commentAuthorsById: Map<string, string> | null;
    contentTypes: ContentTypes;
    images: PPTOCRImage[];
    imageIdByTarget: Map<string, string>;
    nextImageId: () => string;
    ocr: boolean;
    markdown: boolean;
    depth: number;
};

export type PPTParseOptions = {
    ocr: boolean;
    markdown?: boolean;
    depth?: number;
};
