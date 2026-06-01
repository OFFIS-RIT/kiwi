import { isTextUnitSourceChunk, type TextUnitSourceChunk } from "@kiwi/contracts/source";
import type { SourceReferenceChunk, SourceReferenceRecord, SourceReferenceUnitRecord } from "../types/routes";
import { getProjectFileProxyPath } from "./project-file-url";
import { getPdfPreviewPageNumbers } from "./text-unit-preview";

export type SourceReferenceRow = {
    source_id: string;
    source_description: string;
    source_chunk_ids: number[];
    id: string;
    project_file_id: string;
    text: string;
    chunks: unknown[];
    start_page: number | null;
    end_page: number | null;
    file_name: string;
    file_type: string;
    mime_type: string;
    file_key: string;
    created_at: Date | null;
    updated_at: Date | null;
};

const PDF_REGION_PADDING_X = 0.04;
const PDF_REGION_PADDING_Y = 0.06;
const PDF_REGION_MIN_WIDTH = 0.35;
const PDF_REGION_MIN_HEIGHT = 0.16;

type PDFRegionRecord = SourceReferenceRecord["pdf_regions"][number];
type PDFRectangle = PDFRegionRecord["rectangles"][number];

export function toSourceReferenceRecord(graphId: string, row: SourceReferenceRow): SourceReferenceRecord {
    const selectedChunks = selectSourceChunks(row.chunks, row.source_chunk_ids);
    if (selectedChunks.length === 0) {
        return toLegacySourceReferenceRecord(graphId, row);
    }

    const pdfRegions = buildPDFRegions(graphId, row, selectedChunks);
    if (row.file_type === "pdf" && pdfRegions.length === 0) {
        const legacyRecord = toLegacySourceReferenceRecord(graphId, row);
        if (legacyRecord.pdf_regions.length > 0) {
            return legacyRecord;
        }
    }

    const regionChunkIds = new Set(pdfRegions.map((region) => region.chunk_id));

    return {
        source_id: row.source_id,
        description: row.source_description,
        unit: toSourceReferenceUnit(row),
        chunks: selectedChunks.flatMap((chunk) => toReferenceChunk(graphId, row, chunk, regionChunkIds)),
        pdf_regions: pdfRegions,
    };
}

function toSourceReferenceUnit(row: SourceReferenceRow): SourceReferenceUnitRecord {
    return {
        id: row.id,
        project_file_id: row.project_file_id,
        start_page: row.start_page,
        end_page: row.end_page,
        file_name: row.file_name,
        file_type: row.file_type,
        mime_type: row.mime_type,
        created_at: row.created_at?.toISOString() ?? null,
        updated_at: row.updated_at?.toISOString() ?? null,
    };
}

function toLegacySourceReferenceRecord(graphId: string, row: SourceReferenceRow): SourceReferenceRecord {
    return {
        source_id: row.source_id,
        description: row.source_description,
        unit: toSourceReferenceUnit(row),
        chunks:
            row.file_type === "pdf"
                ? []
                : [
                      {
                          type: "text",
                          chunk_id: 1,
                          text: row.text,
                      },
                  ],
        pdf_regions: buildLegacyPDFPageRegions(graphId, row),
    };
}

function buildLegacyPDFPageRegions(graphId: string, row: SourceReferenceRow): SourceReferenceRecord["pdf_regions"] {
    if (row.file_type !== "pdf" || row.start_page === null || row.end_page === null) {
        return [];
    }

    return getPdfPreviewPageNumbers(row.start_page, row.end_page).map((page) => ({
        kind: "page" as const,
        chunk_id: page,
        page,
        width: 1200,
        height: 1600,
        image_path: getPageImagePath(graphId, row.id, page),
        crop: { left: 0, top: 0, width: 1, height: 1 },
        rectangles: [{ left: 0, top: 0, width: 1, height: 1 }],
    }));
}

export function selectSourceChunks(chunks: unknown[], sourceChunkIds: unknown[]): TextUnitSourceChunk[] {
    const validChunks = chunks.filter(isTextUnitSourceChunk);
    const chunksById = new Map(validChunks.map((chunk) => [chunk.id, chunk]));
    const selected: TextUnitSourceChunk[] = [];
    const selectedIds = new Set<number>();

    for (const sourceChunkId of sourceChunkIds) {
        if (typeof sourceChunkId !== "number" || !Number.isInteger(sourceChunkId) || selectedIds.has(sourceChunkId)) {
            continue;
        }

        const chunk = chunksById.get(sourceChunkId);
        if (chunk) {
            selected.push(chunk);
            selectedIds.add(sourceChunkId);
        }
    }

    if (selected.length === 0 && validChunks.length === 1) {
        return validChunks;
    }

    return selected;
}

function buildPDFRegions(
    graphId: string,
    row: SourceReferenceRow,
    chunks: TextUnitSourceChunk[]
): SourceReferenceRecord["pdf_regions"] {
    if (row.file_type !== "pdf") {
        return [];
    }

    return chunks.flatMap((chunk) => buildStoredPDFRegions(graphId, row, chunk));
}

function buildStoredPDFRegions(
    graphId: string,
    row: SourceReferenceRow,
    chunk: TextUnitSourceChunk
): SourceReferenceRecord["pdf_regions"] {
    return (chunk.regions ?? []).flatMap((region) => {
        if (!isValidPDFRegionMetadata(region)) {
            return [];
        }

        const rectangles = getValidPDFRectangles(region.rectangles);
        const crop = cropForRectangles(rectangles);
        if (!crop) {
            return [];
        }

        return [
            {
                kind: region.kind,
                chunk_id: chunk.id,
                page: region.page,
                width: region.width,
                height: region.height,
                image_path: getPageImagePath(graphId, row.id, region.page),
                crop,
                rectangles,
            },
        ];
    });
}

function toReferenceChunk(
    graphId: string,
    row: SourceReferenceRow,
    chunk: TextUnitSourceChunk,
    regionChunkIds: Set<number>
): SourceReferenceChunk[] {
    if (row.file_type === "pdf" && regionChunkIds.has(chunk.id)) {
        return [];
    }

    if (chunk.type === "text") {
        return [{ type: "text", chunk_id: chunk.id, text: chunk.text }];
    }

    if (chunk.imageKey) {
        return [
            {
                type: "image",
                chunk_id: chunk.id,
                image_path: getSourceChunkImagePath(graphId, row.source_id, chunk.id),
                alt: chunk.text || row.file_name,
            },
        ];
    }

    if (row.file_type === "image") {
        return [
            {
                type: "image",
                chunk_id: chunk.id,
                image_path: getProjectFileProxyPath(graphId, row.project_file_id, { fileName: row.file_name }),
                alt: chunk.text || row.file_name,
            },
        ];
    }

    return [{ type: "text", chunk_id: chunk.id, text: chunk.text }];
}

function cropForRectangles(rectangles: PDFRectangle[]): PDFRegionRecord["crop"] | null {
    if (rectangles.length === 0) {
        return null;
    }

    const left = Math.min(...rectangles.map((rectangle) => rectangle.left));
    const top = Math.min(...rectangles.map((rectangle) => rectangle.top));
    const right = Math.max(...rectangles.map((rectangle) => rectangle.left + rectangle.width));
    const bottom = Math.max(...rectangles.map((rectangle) => rectangle.top + rectangle.height));

    return expandCrop({
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
    });
}

function expandCrop(crop: PDFRegionRecord["crop"]): PDFRegionRecord["crop"] {
    const width = Math.max(crop.width + PDF_REGION_PADDING_X * 2, PDF_REGION_MIN_WIDTH);
    const height = Math.max(crop.height + PDF_REGION_PADDING_Y * 2, PDF_REGION_MIN_HEIGHT);
    const centerX = crop.left + crop.width / 2;
    const centerY = crop.top + crop.height / 2;
    const left = clampRatio(centerX - width / 2);
    const top = clampRatio(centerY - height / 2);

    return {
        left: Math.min(left, Math.max(0, 1 - width)),
        top: Math.min(top, Math.max(0, 1 - height)),
        width: Math.min(width, 1),
        height: Math.min(height, 1),
    };
}

function clampRatio(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(1, value));
}

function isValidPDFRegionMetadata(value: unknown): value is {
    kind: PDFRegionRecord["kind"];
    page: number;
    width: number;
    height: number;
    rectangles: unknown;
} {
    if (!value || typeof value !== "object") {
        return false;
    }

    const region = value as Record<string, unknown>;
    return (
        isPDFRegionKind(region.kind) &&
        isPositiveInteger(region.page) &&
        isPositiveFiniteNumber(region.width) &&
        isPositiveFiniteNumber(region.height)
    );
}

function isPDFRegionKind(value: unknown): value is PDFRegionRecord["kind"] {
    return value === "text" || value === "image" || value === "page";
}

function getValidPDFRectangles(rectangles: unknown): PDFRectangle[] {
    if (!Array.isArray(rectangles)) {
        return [];
    }

    return rectangles.filter(isValidPDFRectangle);
}

function isValidPDFRectangle(value: unknown): value is PDFRectangle {
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

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function getPageImagePath(graphId: string, unitId: string, page: number): string {
    return `/graphs/${encodeURIComponent(graphId)}/units/${encodeURIComponent(unitId)}/pages/${page}.png`;
}

function getSourceChunkImagePath(graphId: string, sourceId: string, chunkId: number): string {
    return `/graphs/${encodeURIComponent(graphId)}/sources/${encodeURIComponent(sourceId)}/chunks/${chunkId}/image`;
}
