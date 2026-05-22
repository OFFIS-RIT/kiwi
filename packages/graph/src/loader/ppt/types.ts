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
    | { kind: "bullet"; text: string }
    | { kind: "table"; rows: string[][] }
    | { kind: "image"; id: string };

export type PPTParseContext = {
    zip: JSZip;
    relationships: Relationships;
    contentTypes: ContentTypes;
    images: PPTOCRImage[];
    imageIdByTarget: Map<string, string>;
    nextImageId: () => string;
    ocr: boolean;
};
