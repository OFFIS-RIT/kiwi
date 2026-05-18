import type {
    BoundingBox,
    Edge,
    GraphicsState,
    Matrix2D,
    PDFArrayLike,
    PDFDictLike,
    PDFNameLike,
    PDFNumberLike,
    PDFRefLike,
    PDFStreamLike,
    PathState,
} from "./types";
import { EDGE_JOIN_TOLERANCE, EDGE_MIN_LENGTH, EDGE_SNAP_TOLERANCE } from "./constants";

export function mergeEdges(edges: Edge[]): Edge[] {
    const snapped = edges.filter((edge) => edge.end - edge.start >= EDGE_MIN_LENGTH).map((edge) => ({ ...edge }));

    for (let index = 0; index < snapped.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < snapped.length; otherIndex += 1) {
            const current = snapped[index];
            const other = snapped[otherIndex];
            if (!current || !other) {
                continue;
            }

            if (current.orientation !== other.orientation || current.source !== other.source) {
                continue;
            }

            if (Math.abs(current.position - other.position) <= EDGE_SNAP_TOLERANCE) {
                const position = average([current.position, other.position]);
                current.position = position;
                other.position = position;
            }
        }
    }

    const merged: Edge[] = [];
    const sorted = snapped.sort((a, b) => {
        if (a.orientation !== b.orientation) {
            return a.orientation.localeCompare(b.orientation);
        }

        if (Math.abs(a.position - b.position) > 0.001) {
            return a.position - b.position;
        }

        return a.start - b.start;
    });

    for (const edge of sorted) {
        const last = merged.at(-1);
        if (
            last &&
            last.orientation === edge.orientation &&
            last.source === edge.source &&
            Math.abs(last.position - edge.position) <= EDGE_SNAP_TOLERANCE &&
            edge.start <= last.end + EDGE_JOIN_TOLERANCE
        ) {
            last.start = Math.min(last.start, edge.start);
            last.end = Math.max(last.end, edge.end);
            continue;
        }

        merged.push({ ...edge });
    }

    return merged.filter((edge) => edge.end - edge.start >= EDGE_MIN_LENGTH);
}

export function multiplyMatrices(left: Matrix2D, right: Matrix2D): Matrix2D {
    return {
        a: left.a * right.a + left.b * right.c,
        b: left.a * right.b + left.b * right.d,
        c: left.c * right.a + left.d * right.c,
        d: left.c * right.b + left.d * right.d,
        e: left.e * right.a + left.f * right.c + right.e,
        f: left.e * right.b + left.f * right.d + right.f,
    };
}

export function transformPoint(matrix: Matrix2D, x: number, y: number): { x: number; y: number } {
    return {
        x: matrix.a * x + matrix.c * y + matrix.e,
        y: matrix.b * x + matrix.d * y + matrix.f,
    };
}

export function cloneMatrix(matrix: Matrix2D): Matrix2D {
    return { ...matrix };
}

export function cloneGraphicsState(state: GraphicsState): GraphicsState {
    return {
        ctm: cloneMatrix(state.ctm),
        lineWidth: state.lineWidth,
        path: {
            currentPoint: state.path.currentPoint ? { ...state.path.currentPoint } : null,
            subpathStartPoint: state.path.subpathStartPoint ? { ...state.path.subpathStartPoint } : null,
            subpaths: state.path.subpaths.map((line) => ({ ...line })),
            rectangles: state.path.rectangles.map((rectangle) => ({ ...rectangle })),
        },
    };
}

export function createEmptyPathState(): PathState {
    return {
        currentPoint: null,
        subpathStartPoint: null,
        subpaths: [],
        rectangles: [],
    };
}

export function getMatrixFromArray(array: PDFArrayLike | undefined): Matrix2D | null {
    if (!array || array.length < 6) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < 6; index += 1) {
        const item = array.at(index);
        if (!isPDFNumber(item)) {
            return null;
        }

        values.push(item.value);
    }

    const [a, b, c, d, e, f] = values;
    if (
        a === undefined ||
        b === undefined ||
        c === undefined ||
        d === undefined ||
        e === undefined ||
        f === undefined
    ) {
        return null;
    }

    return { a, b, c, d, e, f };
}

export function isPDFArray(value: unknown): value is PDFArrayLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "array";
}

export function isPDFStream(value: unknown): value is PDFStreamLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "stream";
}

export function isPDFName(value: unknown): value is PDFNameLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "name";
}

export function isPDFStringLike(value: unknown): value is { type: "string"; bytes?: Uint8Array } {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "string";
}

export function isPDFRef(value: unknown): value is PDFRefLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "ref";
}

export function isPDFDict(value: unknown): value is PDFDictLike {
    const type = typeof value === "object" && value !== null ? (value as { type?: string }).type : null;
    return type === "dict" || type === "stream";
}

export function isPDFNumber(value: unknown): value is PDFNumberLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "number";
}

export function safelyDecodeStream(stream: PDFStreamLike): Uint8Array {
    try {
        return stream.getDecodedData();
    } catch {
        return stream.data;
    }
}

export function getTop(bbox: BoundingBox): number {
    return bbox.y + bbox.height;
}

export function overlapLength(startA: number, endA: number, startB: number, endB: number): number {
    return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

export function intersects(a: BoundingBox, b: BoundingBox, threshold = 0): boolean {
    const xOverlap = overlapLength(a.x, a.x + a.width, b.x, b.x + b.width);
    const yOverlap = overlapLength(a.y, getTop(a), b.y, getTop(b));
    if (xOverlap <= 0 || yOverlap <= 0) {
        return false;
    }

    if (threshold <= 0) {
        return true;
    }

    const overlapArea = xOverlap * yOverlap;
    const minArea = Math.min(a.width * a.height, b.width * b.height);
    return overlapArea / Math.max(minArea, 1) >= threshold;
}

export function intersectsAny(bbox: BoundingBox, regions: BoundingBox[], threshold = 0): boolean {
    return regions.some((region) => intersects(bbox, region, threshold));
}

export function unionBoxes(boxes: BoundingBox[]): BoundingBox | null {
    if (boxes.length === 0) {
        return null;
    }

    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

export function boundingBoxFromPoints(points: Array<{ x: number; y: number }>): BoundingBox {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

export function uniqueSorted(values: number[]): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const unique: number[] = [];

    for (const value of sorted) {
        const last = unique.at(-1);
        if (last === undefined || Math.abs(last - value) > EDGE_SNAP_TOLERANCE) {
            unique.push(value);
        } else {
            unique[unique.length - 1] = average([last, value]);
        }
    }

    return unique;
}

export function median(values: number[]): number | null {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? null;
    }

    const left = sorted[middle - 1];
    const right = sorted[middle];
    if (left === undefined || right === undefined) {
        return null;
    }

    return (left + right) / 2;
}

export function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function squashWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}
