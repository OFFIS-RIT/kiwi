export type SourceChunkRegion = {
    kind: "text" | "image" | "page";
    page: number;
    width: number;
    height: number;
    rectangles: Array<{
        left: number;
        top: number;
        width: number;
        height: number;
    }>;
};

export type TextUnitSourceChunk =
    | {
          id: number;
          type: "text";
          text: string;
          startPage: number | null;
          endPage: number | null;
          regions?: SourceChunkRegion[];
      }
    | {
          id: number;
          type: "image";
          text: string;
          imageId: string | null;
          imageKey: string | null;
          startPage: number | null;
          endPage: number | null;
          regions?: SourceChunkRegion[];
      };

export type LoaderSourceChunk =
    | (Omit<Extract<TextUnitSourceChunk, { type: "text" }>, "id"> & {
          startOffset: number;
          endOffset: number;
      })
    | (Omit<Extract<TextUnitSourceChunk, { type: "image" }>, "id"> & {
          startOffset: number;
          endOffset: number;
      });

export type LoadedGraphDocument = {
    text: string;
    sourceChunks?: LoaderSourceChunk[];
};

export function isLoaderSourceChunk(value: unknown): value is LoaderSourceChunk {
    if (!value || typeof value !== "object") {
        return false;
    }

    const chunk = value as Record<string, unknown>;
    const startOffset = chunk.startOffset;
    const endOffset = chunk.endOffset;
    const startPage = chunk.startPage;
    const endPage = chunk.endPage;

    if (chunk.type !== "text" && chunk.type !== "image") {
        return false;
    }

    if (
        typeof chunk.text !== "string" ||
        !isNullablePositiveInteger(startPage) ||
        !isNullablePositiveInteger(endPage) ||
        !isValidPageSpan(startPage, endPage) ||
        !isNonNegativeFiniteNumber(startOffset) ||
        !isNonNegativeFiniteNumber(endOffset) ||
        endOffset < startOffset
    ) {
        return false;
    }

    if (chunk.regions !== undefined && !isSourceChunkRegionArray(chunk.regions)) {
        return false;
    }

    if (chunk.type === "image") {
        return isNullableString(chunk.imageId) && isNullableString(chunk.imageKey);
    }

    return true;
}

export function isTextUnitSourceChunk(value: unknown): value is TextUnitSourceChunk {
    if (!value || typeof value !== "object") {
        return false;
    }

    const chunk = value as Record<string, unknown>;
    if (
        !isPositiveInteger(chunk.id) ||
        typeof chunk.text !== "string" ||
        !isNullablePositiveInteger(chunk.startPage) ||
        !isNullablePositiveInteger(chunk.endPage) ||
        !isValidPageSpan(chunk.startPage, chunk.endPage)
    ) {
        return false;
    }

    if (chunk.regions !== undefined && !Array.isArray(chunk.regions)) {
        return false;
    }

    if (chunk.type === "text") {
        return true;
    }

    if (chunk.type === "image") {
        return isNullableString(chunk.imageId) && isNullableString(chunk.imageKey);
    }

    return false;
}

export function isSourceChunkRegion(value: unknown): value is SourceChunkRegion {
    if (!value || typeof value !== "object") {
        return false;
    }

    const region = value as Record<string, unknown>;
    return (
        isSourceChunkRegionKind(region.kind) &&
        isPositiveInteger(region.page) &&
        isPositiveFiniteNumber(region.width) &&
        isPositiveFiniteNumber(region.height) &&
        Array.isArray(region.rectangles) &&
        region.rectangles.length > 0 &&
        region.rectangles.every(isSourceChunkRectangle)
    );
}

function isSourceChunkRegionArray(value: unknown): value is SourceChunkRegion[] {
    return Array.isArray(value) && value.every(isSourceChunkRegion);
}

function isSourceChunkRegionKind(value: unknown): value is SourceChunkRegion["kind"] {
    return value === "text" || value === "image" || value === "page";
}

function isSourceChunkRectangle(value: unknown): value is SourceChunkRegion["rectangles"][number] {
    if (!value || typeof value !== "object") {
        return false;
    }

    const rectangle = value as Record<string, unknown>;
    return (
        isFiniteNumber(rectangle.left) &&
        isFiniteNumber(rectangle.top) &&
        isPositiveFiniteNumber(rectangle.width) &&
        isPositiveFiniteNumber(rectangle.height)
    );
}

function isValidPageSpan(startPage: number | null, endPage: number | null): boolean {
    return startPage === null || endPage === null || endPage >= startPage;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
    return value === null || isPositiveInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}
