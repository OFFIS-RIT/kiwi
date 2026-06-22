import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import { withWorkerDb } from "../runtime/effect";
import { fileTypeConfigsTable } from "@kiwi/db/tables/file-types";
import { and, eq } from "@kiwi/db/drizzle";
import type { GraphFileType } from "@kiwi/graph/file-type";
import { resolveFileTypeProcessingConfig, type FileTypeProcessingConfig } from "@kiwi/graph/lib/processing-config";

export function getFileTypeProcessingConfig(
    organizationId: string,
    fileType: GraphFileType
): Effect.Effect<FileTypeProcessingConfig, unknown, Database> {
    return Effect.gen(function* () {
        const [row] = yield* withWorkerDb((db) =>
            db
                .select({
                    chunker: fileTypeConfigsTable.chunker,
                    chunkSize: fileTypeConfigsTable.chunkSize,
                    documentMode: fileTypeConfigsTable.documentMode,
                })
                .from(fileTypeConfigsTable)
                .where(
                    and(
                        eq(fileTypeConfigsTable.organizationId, organizationId),
                        eq(fileTypeConfigsTable.fileType, fileType)
                    )
                )
                .limit(1)
        );

        return resolveFileTypeProcessingConfig(fileType, row ?? null);
    });
}
