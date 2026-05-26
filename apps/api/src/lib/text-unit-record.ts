import { and, eq } from "drizzle-orm";
import { db } from "@kiwi/db";
import { filesTable, textUnitTable } from "@kiwi/db/tables/graph";
import type { TextUnitRecord } from "../types/routes";
import { buildTextUnitPreview } from "./text-unit-preview";

export type TextUnitWithFile = {
    id: string;
    project_file_id: string;
    text: string;
    start_page: number | null;
    end_page: number | null;
    file_name: string;
    file_type: string;
    mime_type: string;
    file_key: string;
    created_at: Date | null;
    updated_at: Date | null;
};

export async function loadTextUnitWithFile(graphId: string, unitId: string): Promise<TextUnitWithFile | null> {
    const [unit] = await db
        .select({
            id: textUnitTable.id,
            project_file_id: textUnitTable.fileId,
            text: textUnitTable.text,
            start_page: textUnitTable.startPage,
            end_page: textUnitTable.endPage,
            file_name: filesTable.name,
            file_type: filesTable.type,
            mime_type: filesTable.mimeType,
            file_key: filesTable.key,
            created_at: textUnitTable.createdAt,
            updated_at: textUnitTable.updatedAt,
        })
        .from(textUnitTable)
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(and(eq(textUnitTable.id, unitId), eq(filesTable.graphId, graphId), eq(filesTable.deleted, false)))
        .limit(1);

    return unit ?? null;
}

export function toTextUnitRecord(graphId: string, unit: TextUnitWithFile): TextUnitRecord {
    return {
        id: unit.id,
        project_file_id: unit.project_file_id,
        text: unit.text,
        start_page: unit.start_page,
        end_page: unit.end_page,
        file_name: unit.file_name,
        file_type: unit.file_type,
        mime_type: unit.mime_type,
        preview: buildTextUnitPreview({
            graphId,
            unitId: unit.id,
            fileType: unit.file_type,
            startPage: unit.start_page,
            endPage: unit.end_page,
        }),
        created_at: unit.created_at?.toISOString() ?? null,
        updated_at: unit.updated_at?.toISOString() ?? null,
    };
}

export function isPageInsideUnitSpan(unit: Pick<TextUnitWithFile, "start_page" | "end_page">, page: number): boolean {
    return unit.start_page !== null && unit.end_page !== null && page >= unit.start_page && page <= unit.end_page;
}

export function pngResponse(content: Uint8Array): Response {
    const body = new ArrayBuffer(content.byteLength);
    new Uint8Array(body).set(content);

    return new Response(body, {
        status: 200,
        headers: {
            "Cache-Control": "private, max-age=86400",
            "Content-Length": String(content.byteLength),
            "Content-Type": "image/png",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
