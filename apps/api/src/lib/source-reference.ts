import { and, eq } from "drizzle-orm";
import { db } from "@kiwi/db";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { getFile } from "@kiwi/files";
import { env } from "../env";
import { API_ERROR_CODES } from "../types";
import { selectSourceChunks, toSourceReferenceRecord, type SourceReferenceRow } from "./source-reference-record";

export type { SourceReferenceRow } from "./source-reference-record";

export type SourceReferenceImage = {
    content: Uint8Array;
    contentType: string;
};

export async function loadSourceReference(graphId: string, sourceId: string) {
    const row = await loadSourceReferenceRow(graphId, sourceId);
    if (!row) {
        throw new Error(API_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    return toSourceReferenceRecord(graphId, row);
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

    const file = await getFile(chunk.imageKey, env.S3_BUCKET, "bytes");
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
        .select({
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
        })
        .from(sourcesTable)
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(and(eq(sourcesTable.id, sourceId), eq(filesTable.graphId, graphId), eq(filesTable.deleted, false)))
        .limit(1);

    return row ? normalizeSourceReferenceRow(row) : null;
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
