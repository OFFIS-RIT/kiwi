import { and, eq, inArray } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { currentSourcePredicate, visibleFilePredicate } from "@kiwi/db/source-validity";
import { getFile } from "@kiwi/files";
import type { SourceReferenceBatchSuccessData } from "@kiwi/contracts";
import { env } from "../env";
import { API_ERROR_CODES } from "../types";
import { selectSourceChunks, toSourceReferenceRecord, type SourceReferenceRow } from "./source-reference-record";

export type { SourceReferenceRow } from "./source-reference-record";

export type SourceReferenceImage = {
    content: Uint8Array;
    contentType: string;
};

const sourceReferenceSelect = {
    source_id: sourcesTable.id,
    source_description: sourcesTable.description,
    source_chunk_ids: sourcesTable.sourceChunkIds,
    id: textUnitTable.id,
    project_file_id: textUnitTable.fileId,
    text: textUnitTable.text,
    chunks: textUnitTable.chunks,
    start_page: textUnitTable.startPage,
    end_page: textUnitTable.endPage,
    file_name: filesTable.name,
    file_type: filesTable.type,
    mime_type: filesTable.mimeType,
    file_key: filesTable.key,
    created_at: textUnitTable.createdAt,
    updated_at: textUnitTable.updatedAt,
};

export async function loadSourceReference(graphId: string, sourceId: string) {
    const row = await loadSourceReferenceRow(graphId, sourceId);
    if (!row) {
        throw new Error(API_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    return toSourceReferenceRecord(graphId, row);
}

export async function loadSourceReferences(
    graphId: string,
    sourceIds: string[]
): Promise<SourceReferenceBatchSuccessData> {
    const uniqueSourceIds = normalizeSourceIds(sourceIds);
    if (uniqueSourceIds.length === 0) {
        return { items: [], missing_source_ids: [] };
    }

    const rows = await loadSourceReferenceRows(graphId, uniqueSourceIds);
    const rowsBySourceId = new Map(rows.map((row) => [row.source_id, row]));
    const items: SourceReferenceBatchSuccessData["items"] = [];
    const missingSourceIds: string[] = [];

    for (const sourceId of uniqueSourceIds) {
        const row = rowsBySourceId.get(sourceId);
        if (!row) {
            missingSourceIds.push(sourceId);
            continue;
        }

        items.push(toSourceReferenceRecord(graphId, row));
    }

    return {
        items,
        missing_source_ids: missingSourceIds,
    };
}

export async function loadSourceReferenceImage(
    graphId: string,
    sourceId: string,
    chunkId: number
): Promise<SourceReferenceImage> {
    const row = await loadSourceReferenceRow(graphId, sourceId);
    if (!row) {
        throw new Error(API_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    const chunk = selectSourceChunks(row.chunks, row.source_chunk_ids).find((candidate) => candidate.id === chunkId);
    if (!chunk || chunk.type !== "image" || !chunk.imageKey) {
        throw new Error(API_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    const file = await Effect.runPromise(getFile(chunk.imageKey, env.S3_BUCKET, "bytes"));
    if (!file) {
        throw new Error(API_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    return {
        content: new Uint8Array(file.content),
        contentType: getImageContentType(chunk.imageKey),
    };
}

async function loadSourceReferenceRow(graphId: string, sourceId: string): Promise<SourceReferenceRow | null> {
    const [row] = await db
        .select(sourceReferenceSelect)
        .from(sourcesTable)
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(
            and(
                eq(sourcesTable.id, sourceId),
                eq(filesTable.graphId, graphId),
                currentSourcePredicate(sourcesTable),
                visibleFilePredicate(filesTable)
            )
        )
        .limit(1);

    return row ? normalizeSourceReferenceRow(row) : null;
}

async function loadSourceReferenceRows(graphId: string, sourceIds: string[]): Promise<SourceReferenceRow[]> {
    const rows = await db
        .select(sourceReferenceSelect)
        .from(sourcesTable)
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(
            and(
                inArray(sourcesTable.id, sourceIds),
                eq(filesTable.graphId, graphId),
                currentSourcePredicate(sourcesTable),
                visibleFilePredicate(filesTable)
            )
        );

    return rows.map(normalizeSourceReferenceRow);
}

function normalizeSourceIds(sourceIds: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const sourceId of sourceIds) {
        const normalized = sourceId.trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        result.push(normalized);
    }

    return result;
}

function normalizeSourceReferenceRow(row: SourceReferenceRow): SourceReferenceRow {
    return {
        ...row,
        source_chunk_ids: Array.isArray(row.source_chunk_ids) ? row.source_chunk_ids : [],
        chunks: Array.isArray(row.chunks) ? row.chunks : [],
    };
}

function getImageContentType(key: string): string {
    const extension = key.split(".").pop()?.toLowerCase();

    switch (extension) {
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "webp":
            return "image/webp";
        case "svg":
            return "image/svg+xml";
        case "tif":
        case "tiff":
            return "image/tiff";
        default:
            return "application/octet-stream";
    }
}
