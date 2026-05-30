import type { LoaderSourceChunk, SourceChunkRegion } from "@kiwi/graph";
import { getFile } from "@kiwi/files";

type SourceMapFileReader = (key: string, bucket: string, type: "json") => Promise<{ content: unknown } | null>;

const defaultReadFile: SourceMapFileReader = (key, bucket, type) => getFile<unknown>(key, bucket, type);

export async function loadSourceMap(
    key: string,
    bucket: string,
    deps: { readFile?: SourceMapFileReader } = {}
): Promise<LoaderSourceChunk[]> {
    const sourceMap = await (deps.readFile ?? defaultReadFile)(key, bucket, "json");
    if (!sourceMap || !Array.isArray(sourceMap.content) || !sourceMap.content.every(isLoaderSourceChunk)) {
        throw new Error(`Failed to load source map from ${key}`);
    }

    return sourceMap.content;
}

function isLoaderSourceChunk(value: unknown): value is LoaderSourceChunk {
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
        !isNullableInteger(startPage) ||
        !isNullableInteger(endPage) ||
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

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableInteger(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1);
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isValidPageSpan(startPage: number | null, endPage: number | null): boolean {
    return startPage === null || endPage === null || endPage >= startPage;
}

function isSourceChunkRegionArray(value: unknown): value is SourceChunkRegion[] {
    return Array.isArray(value) && value.every(isSourceChunkRegion);
}

function isSourceChunkRegion(value: unknown): value is SourceChunkRegion {
    if (!value || typeof value !== "object") {
        return false;
    }

    const region = value as Record<string, unknown>;
    return (
        isSourceChunkRegionKind(region.kind) &&
        isNullableInteger(region.page) &&
        region.page !== null &&
        isPositiveFiniteNumber(region.width) &&
        isPositiveFiniteNumber(region.height) &&
        Array.isArray(region.rectangles) &&
        region.rectangles.length > 0 &&
        region.rectangles.every(isSourceChunkRectangle)
    );
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

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}
