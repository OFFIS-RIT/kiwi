import type JSZip from "jszip";
import type { ContentTypes, Relationships } from "../ooxml/types";

export type DOCOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

export type ParsedDOC = {
    blocks: DOCBlock[];
    images: DOCOCRImage[];
};

export type DOCBlock =
    | { kind: "heading"; level: number; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "bullet"; text: string; level: number; ordered: boolean }
    | { kind: "table"; rows: string[][]; hasHeader: boolean }
    | { kind: "image"; id: string }
    | { kind: "pageBreak" };

export type DOCStyles = Map<string, { name: string | null; headingLevel: number | null }>;

export type DOCNumbering = {
    numToAbstract: Map<string, string>;
    abstractFormats: Map<string, Map<number, string>>;
};

export type ParagraphListInfo = {
    level: number;
    ordered: boolean;
};

export type DOCParseContext = {
    zip: JSZip;
    partPath: string;
    relationships: Relationships;
    relationshipsByPart: Map<string, Relationships>;
    contentTypes: ContentTypes;
    styles: DOCStyles;
    numbering: DOCNumbering;
    referenceTexts: {
        footnotes: Map<string, string>;
        endnotes: Map<string, string>;
        comments: Map<string, string>;
    };
    images: DOCOCRImage[];
    imageIdByTarget: Map<string, string>;
    nextImageId: () => string;
    ocr: boolean;
    markdown: boolean;
    depth: number;
    seenPartPaths: Set<string>;
};

export type DOCParseOptions = {
    ocr: boolean;
    markdown?: boolean;
    depth?: number;
};
