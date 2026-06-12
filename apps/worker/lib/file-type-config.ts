import { db } from "@kiwi/db";
import { fileTypeConfigsTable } from "@kiwi/db/tables/file-types";
import { and, eq } from "drizzle-orm";
import type { GraphFileType } from "@kiwi/graph/file-type";
import { resolveFileTypeProcessingConfig, type FileTypeProcessingConfig } from "@kiwi/graph/lib/processing-config";

export async function getFileTypeProcessingConfig(
    organizationId: string,
    fileType: GraphFileType
): Promise<FileTypeProcessingConfig> {
    const [row] = await db
        .select({
            chunker: fileTypeConfigsTable.chunker,
            chunkSize: fileTypeConfigsTable.chunkSize,
            documentMode: fileTypeConfigsTable.documentMode,
        })
        .from(fileTypeConfigsTable)
        .where(
            and(eq(fileTypeConfigsTable.organizationId, organizationId), eq(fileTypeConfigsTable.fileType, fileType))
        )
        .limit(1);

    return resolveFileTypeProcessingConfig(fileType, row ?? null);
}
