import { isPDFNumber } from "./geometry";
import type { BoundingBox, PDFDictLike, PDFDocumentLike, PDFPageLike } from "./types";

export type PDFPageRotation = 0 | 90 | 180 | 270;

// Mirrors what both rasterizers draw: the CropBox intersected with the
// MediaBox (pdf.js semantics; Ghostscript runs with -dUseCropBox), with
// /Rotate applied. renderBox is in unrotated PDF user space; the rendered
// dimensions are swapped for 90/270 degree rotations.
export type PDFPageGeometry = {
    pageNumber: number;
    rotation: PDFPageRotation;
    renderBox: BoundingBox;
    renderedWidth: number;
    renderedHeight: number;
};

const MAX_PAGE_TREE_DEPTH = 64;
const DEFAULT_PAGE_BOX: BoundingBox = { x: 0, y: 0, width: 612, height: 792 };

export function getPDFPageGeometry(pdf: PDFDocumentLike, page: Pick<PDFPageLike, "index" | "dict">): PDFPageGeometry {
    const resolver = pdf.getObject.bind(pdf);
    const rotation = getPageRotation(page.dict, resolver);
    const renderBox = getPageRenderBox(page.dict, resolver);
    const swapped = rotation === 90 || rotation === 270;

    return {
        pageNumber: page.index + 1,
        rotation,
        renderBox,
        renderedWidth: swapped ? renderBox.height : renderBox.width,
        renderedHeight: swapped ? renderBox.width : renderBox.height,
    };
}

type Resolver = Parameters<PDFDictLike["get"]>[1];

function getPageRenderBox(dict: PDFDictLike, resolver: Resolver): BoundingBox {
    const mediaBox = getInheritedPageBox(dict, "MediaBox", resolver) ?? DEFAULT_PAGE_BOX;
    const cropBox = getInheritedPageBox(dict, "CropBox", resolver);
    if (!cropBox) {
        return mediaBox;
    }

    return intersectBoxes(cropBox, mediaBox) ?? mediaBox;
}

function getInheritedPageBox(dict: PDFDictLike, name: string, resolver: Resolver): BoundingBox | null {
    let current: PDFDictLike | undefined = dict;

    for (let depth = 0; current && depth < MAX_PAGE_TREE_DEPTH; depth += 1) {
        const box = parseBoxArray(current, name, resolver);
        if (box) {
            return box;
        }

        current = current.getDict("Parent", resolver);
    }

    return null;
}

function parseBoxArray(dict: PDFDictLike, name: string, resolver: Resolver): BoundingBox | null {
    const array = dict.getArray(name, resolver);
    if (!array || array.length < 4) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < 4; index += 1) {
        const item = array.at(index, resolver);
        if (!isPDFNumber(item) || !Number.isFinite(item.value)) {
            return null;
        }

        values.push(item.value);
    }

    const [x1, y1, x2, y2] = values as [number, number, number, number];
    const box = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
    };
    return box.width > 0 && box.height > 0 ? box : null;
}

function getPageRotation(dict: PDFDictLike, resolver: Resolver): PDFPageRotation {
    let current: PDFDictLike | undefined = dict;

    for (let depth = 0; current && depth < MAX_PAGE_TREE_DEPTH; depth += 1) {
        const rotate = current.getNumber("Rotate", resolver);
        if (rotate && Number.isFinite(rotate.value)) {
            return normalizeRotation(rotate.value);
        }

        current = current.getDict("Parent", resolver);
    }

    return 0;
}

function normalizeRotation(value: number): PDFPageRotation {
    const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function intersectBoxes(a: BoundingBox, b: BoundingBox): BoundingBox | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const top = Math.min(a.y + a.height, b.y + b.height);
    if (right <= x || top <= y) {
        return null;
    }

    return { x, y, width: right - x, height: top - y };
}
