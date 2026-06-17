import { db } from "@kiwi/db";
import { fileTypeConfigsTable } from "@kiwi/db/tables/file-types";
import { FILE_TYPE_CHUNK_SIZE_MAX, FILE_TYPE_CHUNK_SIZE_MIN, type FileTypeConfigRecord } from "@kiwi/contracts";
import { GRAPH_FILE_TYPES, isGraphFileType, type GraphFileType } from "@kiwi/graph/file-type";
import { GRAPH_DOCUMENT_MODES } from "@kiwi/graph/loader/factory";
import {
    defaultFileTypeProcessingConfig,
    fileTypeSupportsChunkSize,
    fileTypeSupportsDocumentMode,
    resolveFileTypeProcessingConfig,
    type FileTypeProcessingConfig,
} from "@kiwi/graph/lib/processing-config";
import { Result } from "better-result";
import { asc, eq, sql } from "drizzle-orm";
import Elysia from "elysia";
import z from "zod";
import { requireOrganizationAdmin } from "../lib/team-access";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

type RouteStatus = (code: number, body: unknown) => unknown;

const patchFileTypeConfigSchema = z.object({
    chunk_size: z.number().int().min(FILE_TYPE_CHUNK_SIZE_MIN).max(FILE_TYPE_CHUNK_SIZE_MAX).optional(),
    document_mode: z.enum(GRAPH_DOCUMENT_MODES).optional(),
});

function toFileTypeConfigRecord(fileType: GraphFileType, config: FileTypeProcessingConfig): FileTypeConfigRecord {
    return {
        file_type: fileType,
        loader: config.loader,
        chunker: config.chunker,
        chunk_size: config.chunkSize,
        document_mode: config.documentMode,
        chunk_size_editable: fileTypeSupportsChunkSize(fileType),
        document_mode_editable: fileTypeSupportsDocumentMode(fileType),
    };
}

function mapFileTypeError(status: RouteStatus, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    switch (error.message) {
        case API_ERROR_CODES.UNAUTHORIZED:
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        case API_ERROR_CODES.FORBIDDEN:
            return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
        case API_ERROR_CODES.FILE_TYPE_NOT_FOUND:
            return status(404, errorResponse("File type not found", API_ERROR_CODES.FILE_TYPE_NOT_FOUND));
        case API_ERROR_CODES.INVALID_FILE_TYPE_CONFIG:
            return status(
                400,
                errorResponse("Invalid file type configuration", API_ERROR_CODES.INVALID_FILE_TYPE_CONFIG)
            );
        case API_ERROR_CODES.NO_CHANGES:
            return status(400, errorResponse("No changes provided", API_ERROR_CODES.NO_CHANGES));
        default:
            return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }
}

async function runFileTypeAction<T>(options: {
    status: RouteStatus;
    user: AuthUser | null | undefined;
    action: (user: AuthUser) => Promise<T>;
    success: (value: T) => unknown;
}) {
    if (!options.user) {
        return options.status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
    }

    const result = await Result.tryPromise(async () => options.action(options.user!));
    if (result.isErr()) {
        return mapFileTypeError(options.status, result.error);
    }

    return options.success(result.value);
}

export const fileTypesRoute = new Elysia({ prefix: "/file-types" })
    .use(authMiddleware)
    .get("/", async ({ status, user }) =>
        runFileTypeAction({
            user,
            status,
            action: async (currentUser) => {
                const membership = await requireOrganizationAdmin(currentUser);

                const rows = await db
                    .select({
                        fileType: fileTypeConfigsTable.fileType,
                        chunker: fileTypeConfigsTable.chunker,
                        chunkSize: fileTypeConfigsTable.chunkSize,
                        documentMode: fileTypeConfigsTable.documentMode,
                    })
                    .from(fileTypeConfigsTable)
                    .where(eq(fileTypeConfigsTable.organizationId, membership.organizationId))
                    .orderBy(asc(fileTypeConfigsTable.fileType));
                const rowsByFileType = new Map(rows.map((row) => [row.fileType, row]));

                return GRAPH_FILE_TYPES.map((fileType) =>
                    toFileTypeConfigRecord(
                        fileType,
                        resolveFileTypeProcessingConfig(fileType, rowsByFileType.get(fileType) ?? null)
                    )
                );
            },
            success: (value) => status(200, successResponse(value)),
        })
    )
    .patch(
        "/:fileType",
        async ({ body, params, status, user }) =>
            runFileTypeAction({
                user,
                status,
                action: async (currentUser) => {
                    const membership = await requireOrganizationAdmin(currentUser);

                    if (!isGraphFileType(params.fileType)) {
                        throw new Error(API_ERROR_CODES.FILE_TYPE_NOT_FOUND);
                    }
                    const fileType = params.fileType;

                    if (body.chunk_size === undefined && body.document_mode === undefined) {
                        throw new Error(API_ERROR_CODES.NO_CHANGES);
                    }

                    if (body.chunk_size !== undefined && !fileTypeSupportsChunkSize(fileType)) {
                        throw new Error(API_ERROR_CODES.INVALID_FILE_TYPE_CONFIG);
                    }

                    if (body.document_mode !== undefined && !fileTypeSupportsDocumentMode(fileType)) {
                        throw new Error(API_ERROR_CODES.INVALID_FILE_TYPE_CONFIG);
                    }

                    const defaults = defaultFileTypeProcessingConfig(fileType);
                    const [row] = await db
                        .insert(fileTypeConfigsTable)
                        .values({
                            organizationId: membership.organizationId,
                            fileType,
                            loader: defaults.loader,
                            chunker: defaults.chunker,
                            chunkSize: body.chunk_size ?? defaults.chunkSize,
                            documentMode: body.document_mode ?? defaults.documentMode,
                        })
                        .onConflictDoUpdate({
                            target: [fileTypeConfigsTable.organizationId, fileTypeConfigsTable.fileType],
                            set: {
                                ...(body.chunk_size !== undefined ? { chunkSize: body.chunk_size } : {}),
                                ...(body.document_mode !== undefined ? { documentMode: body.document_mode } : {}),
                                updatedAt: sql`NOW()`,
                            },
                        })
                        .returning();

                    if (!row) {
                        throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
                    }

                    return toFileTypeConfigRecord(fileType, resolveFileTypeProcessingConfig(fileType, row));
                },
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: z.object({
                fileType: z.string(),
            }),
            body: patchFileTypeConfigSchema,
        }
    );
