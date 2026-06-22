import { asc, eq, sql } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { fileTypeConfigsTable } from "@kiwi/db/tables/file-types";
import { API_ERROR_CODES, internalServerError, makeApiError } from "@kiwi/contracts/errors";
import type { FileTypeConfigPatchInput, FileTypeConfigRecord } from "@kiwi/contracts/file-types";
import { GRAPH_FILE_TYPES, isGraphFileType, type GraphFileType } from "@kiwi/graph/file-type";
import {
    defaultFileTypeProcessingConfig,
    fileTypeSupportsChunkSize,
    fileTypeSupportsDocumentMode,
    resolveFileTypeProcessingConfig,
    type FileTypeProcessingConfig,
} from "@kiwi/graph/lib/processing-config";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

function toFileTypeConfigRecord(fileType: GraphFileType, config: FileTypeProcessingConfig): FileTypeConfigRecord {
    const chunkSizeEditable = fileTypeSupportsChunkSize(fileType);
    if (chunkSizeEditable && config.chunkSize === null) {
        throw new Error(`Editable file type "${fileType}" resolved without a chunk size`);
    }

    return {
        file_type: fileType,
        loader: config.loader,
        chunker: config.chunker,
        chunk_size: config.chunkSize,
        document_mode: config.documentMode,
        chunk_size_editable: chunkSizeEditable,
        document_mode_editable: fileTypeSupportsDocumentMode(fileType),
    };
}

export function listFileTypeConfigs(input: { user: AuthUser }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                const membership = yield* requireOrganizationAdmin(input.user);

                const rows = yield* tryDb((db) =>
                    db
                        .select({
                            fileType: fileTypeConfigsTable.fileType,
                            chunker: fileTypeConfigsTable.chunker,
                            chunkSize: fileTypeConfigsTable.chunkSize,
                            documentMode: fileTypeConfigsTable.documentMode,
                        })
                        .from(fileTypeConfigsTable)
                        .where(eq(fileTypeConfigsTable.organizationId, membership.organizationId))
                        .orderBy(asc(fileTypeConfigsTable.fileType))
                );
                const rowsByFileType = new Map(rows.map((row) => [row.fileType, row]));

                return GRAPH_FILE_TYPES.map((fileType) =>
                    toFileTypeConfigRecord(
                        fileType,
                        resolveFileTypeProcessingConfig(fileType, rowsByFileType.get(fileType) ?? null)
                    )
                );
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}

export function patchFileTypeConfig(input: { user: AuthUser; fileType: string; body: FileTypeConfigPatchInput }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                const membership = yield* requireOrganizationAdmin(input.user);
                if (!isGraphFileType(input.fileType)) {
                    return yield* Effect.fail(
                        makeApiError(404, API_ERROR_CODES.FILE_TYPE_NOT_FOUND, "File type not found")
                    );
                }
                const fileType = input.fileType;

                if (input.body.chunk_size === undefined && input.body.document_mode === undefined) {
                    return yield* Effect.fail(makeApiError(400, API_ERROR_CODES.NO_CHANGES, "No changes provided"));
                }

                if (input.body.chunk_size !== undefined && !fileTypeSupportsChunkSize(fileType)) {
                    return yield* Effect.fail(
                        makeApiError(400, API_ERROR_CODES.INVALID_FILE_TYPE_CONFIG, "Invalid file type configuration")
                    );
                }

                if (input.body.document_mode !== undefined && !fileTypeSupportsDocumentMode(fileType)) {
                    return yield* Effect.fail(
                        makeApiError(400, API_ERROR_CODES.INVALID_FILE_TYPE_CONFIG, "Invalid file type configuration")
                    );
                }

                const defaults = defaultFileTypeProcessingConfig(fileType);
                const [row] = yield* tryDb((db) =>
                    db
                        .insert(fileTypeConfigsTable)
                        .values({
                            organizationId: membership.organizationId,
                            fileType,
                            loader: defaults.loader,
                            chunker: defaults.chunker,
                            chunkSize: input.body.chunk_size ?? defaults.chunkSize,
                            documentMode: input.body.document_mode ?? defaults.documentMode,
                        })
                        .onConflictDoUpdate({
                            target: [fileTypeConfigsTable.organizationId, fileTypeConfigsTable.fileType],
                            set: {
                                ...(input.body.chunk_size !== undefined ? { chunkSize: input.body.chunk_size } : {}),
                                ...(input.body.document_mode !== undefined
                                    ? { documentMode: input.body.document_mode }
                                    : {}),
                                updatedAt: sql`NOW()`,
                            },
                        })
                        .returning()
                );

                if (!row) {
                    return yield* Effect.fail(internalServerError());
                }

                return toFileTypeConfigRecord(fileType, resolveFileTypeProcessingConfig(fileType, row));
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}
