import { and, asc, eq } from "drizzle-orm";
import { Result } from "better-result";
import { Elysia, t } from "elysia";
import { db } from "@kiwi/db";
import { filesTable } from "@kiwi/db/tables/graph";
import { error as logError } from "@kiwi/logger";
import { env } from "../env";
import { binaryResponse } from "../lib/binary-response";
import { verifyProjectFileAccessToken } from "../lib/project-file-access-token";
import { assertCanViewGraph } from "../lib/graph-access";
import { getGraphFileProxyResponse, loadGraphFileByKey, loadGraphFileForProxy } from "../lib/graph-file-proxy";
import { mapGraphError, selectGraphDetailFileFields, toGraphFileRecord, type GraphFileRow } from "../lib/graph-route";
import { getOrRenderPDFPreviewPage } from "../lib/pdf-preview-cache";
import { getProjectFileProxyPath } from "../lib/project-file-url";
import {
    loadSourceReference,
    loadSourceReferenceImage,
    loadSourceReferences,
    type SourceReferenceImage,
} from "../lib/source-reference";
import { getPdfPreviewPageNumbers, parsePageImageParam } from "../lib/text-unit-preview";
import { loadTextUnitWithFile, pngResponse, toTextUnitRecord } from "../lib/text-unit-record";
import { mapUnitError } from "../lib/unit";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { assertPermissions, requirePermissions } from "../middleware/permissions";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

type FileRouteStatus = (code: number, body: unknown) => unknown;
type FileRouteParams = { id: string; fileId: string };

async function assertCanReadFile(request: Request, user: AuthUser | null, params: FileRouteParams) {
    const accessToken = new URL(request.url).searchParams.get("token");
    const hasTokenAccess = await verifyProjectFileAccessToken(accessToken, params.id, params.fileId);

    if (hasTokenAccess) {
        return;
    }

    if (!user) {
        throw new Error(API_ERROR_CODES.UNAUTHORIZED);
    }

    await assertPermissions(request.headers, { graph: ["view"] });
    await assertCanViewGraph(user, params.id);
}

function mapFileRouteError(status: FileRouteStatus, error: unknown) {
    if (error instanceof Error && error.message === API_ERROR_CODES.UNAUTHORIZED) {
        return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
    }

    return mapGraphError(status, error);
}

function mapSourceReferenceError(status: FileRouteStatus, error: unknown) {
    if (error instanceof Error && error.message === API_ERROR_CODES.SOURCE_NOT_FOUND) {
        return status(404, errorResponse("Source not found", API_ERROR_CODES.SOURCE_NOT_FOUND));
    }

    return mapUnitError(status, error);
}

function sourceReferenceImageResponse(image: SourceReferenceImage): Response {
    return binaryResponse(image.content, { contentType: image.contentType });
}

async function serveGraphFile({
    head = false,
    params,
    request,
    status,
    user,
}: {
    head?: boolean;
    params: FileRouteParams;
    request: Request;
    status: FileRouteStatus;
    user: AuthUser | null;
}) {
    const proxyResult = await Result.tryPromise(async () => {
        await assertCanReadFile(request, user, params);

        return getGraphFileProxyResponse({
            graphId: params.id,
            fileId: params.fileId,
            request,
            bucket: env.S3_BUCKET,
            head,
        });
    });

    if (proxyResult.isErr()) {
        return mapFileRouteError(status, proxyResult.error);
    }

    if (proxyResult.value.status === "not_found") {
        return status(404, errorResponse("File not found", API_ERROR_CODES.INVALID_FILE_IDS));
    }

    if (proxyResult.value.status === "invalid_range") {
        return new Response(null, {
            status: 416,
            headers: {
                "Accept-Ranges": "bytes",
                "Content-Range": `bytes */${proxyResult.value.size}`,
            },
        });
    }

    return proxyResult.value.response;
}

async function redirectToNamedGraphFile({
    params,
    request,
    status,
    user,
}: {
    params: FileRouteParams;
    request: Request;
    status: FileRouteStatus;
    user: AuthUser | null;
}) {
    const requestUrl = new URL(request.url);

    const fileResult = await Result.tryPromise(async () => {
        await assertCanReadFile(request, user, params);

        return loadGraphFileForProxy(params.id, params.fileId);
    });

    if (fileResult.isErr()) {
        return mapFileRouteError(status, fileResult.error);
    }

    if (!fileResult.value) {
        return status(404, errorResponse("File not found", API_ERROR_CODES.INVALID_FILE_IDS));
    }

    const location = `${getProjectFileProxyPath(params.id, params.fileId, {
        fileName: fileResult.value.name,
    })}${requestUrl.search}`;

    return new Response(null, {
        status: 307,
        headers: { Location: location },
    });
}

export const graphFilesRoute = new Elysia({ prefix: "/graphs" })
    .use(authMiddleware)
    .get(
        "/:id/files",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const filesResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);

                const fileRows: GraphFileRow[] = await db
                    .select(selectGraphDetailFileFields)
                    .from(filesTable)
                    .where(and(eq(filesTable.graphId, params.id), eq(filesTable.deleted, false)))
                    .orderBy(asc(filesTable.createdAt), asc(filesTable.name));

                return fileRows.map(toGraphFileRecord);
            });

            if (filesResult.isErr()) {
                return mapGraphError(status, filesResult.error);
            }

            return status(200, successResponse(filesResult.value));
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["list:file"],
            }),
        }
    )
    .get(
        "/:id/files/:fileId/:filename",
        async ({ params, request, user, status }) => serveGraphFile({ params, request, status, user }),
        {
            params: t.Object({
                id: t.String(),
                fileId: t.String(),
                filename: t.String(),
            }),
        }
    )
    .head(
        "/:id/files/:fileId/:filename",
        async ({ params, request, user, status }) => serveGraphFile({ head: true, params, request, status, user }),
        {
            params: t.Object({
                id: t.String(),
                fileId: t.String(),
                filename: t.String(),
            }),
        }
    )
    .get(
        "/:id/files/:fileId",
        async ({ params, request, user, status }) => redirectToNamedGraphFile({ params, request, status, user }),
        {
            params: t.Object({
                id: t.String(),
                fileId: t.String(),
            }),
        }
    )
    .head(
        "/:id/files/:fileId",
        async ({ params, request, user, status }) => redirectToNamedGraphFile({ params, request, status, user }),
        {
            params: t.Object({
                id: t.String(),
                fileId: t.String(),
            }),
        }
    )
    .post(
        "/:id/file",
        async ({ body, params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const fileResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);

                const file = await loadGraphFileByKey(params.id, body.file_key);
                if (!file) {
                    return status(400, errorResponse("Invalid file IDs", API_ERROR_CODES.INVALID_FILE_IDS));
                }

                return status(
                    200,
                    successResponse({ url: getProjectFileProxyPath(params.id, file.id, { fileName: file.name }) })
                );
            });

            if (fileResult.isErr()) {
                return mapGraphError(status, fileResult.error);
            }

            return fileResult.value;
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            body: t.Object({
                file_key: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .get(
        "/:id/sources/:sourceId/chunks/:chunkId/image",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const chunkId = Number(params.chunkId);
            if (!Number.isInteger(chunkId) || chunkId < 1) {
                return status(404, errorResponse("Source not found", API_ERROR_CODES.SOURCE_NOT_FOUND));
            }

            const imageResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);
                return loadSourceReferenceImage(params.id, params.sourceId, chunkId);
            });

            if (imageResult.isErr()) {
                return mapSourceReferenceError(status, imageResult.error);
            }

            return sourceReferenceImageResponse(imageResult.value);
        },
        {
            params: t.Object({
                id: t.String(),
                sourceId: t.String(),
                chunkId: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .get(
        "/:id/sources/:sourceId/reference",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const referenceResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);
                return loadSourceReference(params.id, params.sourceId);
            });

            if (referenceResult.isErr()) {
                return mapSourceReferenceError(status, referenceResult.error);
            }

            return status(200, successResponse(referenceResult.value));
        },
        {
            params: t.Object({
                id: t.String(),
                sourceId: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .post(
        "/:id/sources/references",
        async ({ body, params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const referenceResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);
                return loadSourceReferences(params.id, body.source_ids);
            });

            if (referenceResult.isErr()) {
                return mapSourceReferenceError(status, referenceResult.error);
            }

            return status(200, successResponse(referenceResult.value));
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            body: t.Object({
                source_ids: t.Array(t.String()),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .get(
        "/:id/units/:unitId",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const unitResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);

                const unit = await loadTextUnitWithFile(params.id, params.unitId);
                if (!unit) {
                    throw new Error(API_ERROR_CODES.TEXT_UNIT_NOT_FOUND);
                }

                return toTextUnitRecord(params.id, unit);
            });

            if (unitResult.isErr()) {
                return mapUnitError(status, unitResult.error);
            }

            return status(200, successResponse(unitResult.value));
        },
        {
            params: t.Object({
                id: t.String(),
                unitId: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .get(
        "/:id/units/:unitId/pages/:page",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const page = parsePageImageParam(params.page);
            if (page === null) {
                return status(404, errorResponse("Text unit not found", API_ERROR_CODES.TEXT_UNIT_NOT_FOUND));
            }

            const unitResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);
                return loadTextUnitWithFile(params.id, params.unitId);
            });

            if (unitResult.isErr()) {
                return mapGraphError(status, unitResult.error);
            }

            const unit = unitResult.value;
            if (!unit) {
                return status(404, errorResponse("Text unit not found", API_ERROR_CODES.TEXT_UNIT_NOT_FOUND));
            }
            if (unit.file_type !== "pdf") {
                return status(415, errorResponse("Unsupported file type", API_ERROR_CODES.UNSUPPORTED_FILE_TYPE));
            }
            const startPage = unit.start_page;
            const endPage = unit.end_page;
            if (startPage === null || endPage === null || page < startPage || page > endPage) {
                return status(422, errorResponse("Invalid page range", API_ERROR_CODES.INVALID_PAGE_RANGE));
            }

            const previewResult = await Result.tryPromise(async () =>
                getOrRenderPDFPreviewPage({
                    graphId: params.id,
                    fileId: unit.project_file_id,
                    fileKey: unit.file_key,
                    page,
                    pagesToRender: getPdfPreviewPageNumbers(startPage, endPage),
                    bucket: env.S3_BUCKET,
                })
            );

            if (previewResult.isErr()) {
                logError("failed to render PDF text unit preview", {
                    graphId: params.id,
                    unitId: params.unitId,
                    fileId: unit.project_file_id,
                    page,
                    error: previewResult.error,
                });

                return status(
                    500,
                    errorResponse("Failed to render PDF preview", API_ERROR_CODES.INTERNAL_SERVER_ERROR)
                );
            }

            if (previewResult.value.status === "source_missing") {
                return status(404, errorResponse("File not found", API_ERROR_CODES.INVALID_FILE_IDS));
            }
            if (previewResult.value.status === "page_missing") {
                return status(404, errorResponse("PDF preview page not found", API_ERROR_CODES.INVALID_PAGE_RANGE));
            }

            return pngResponse(previewResult.value.content);
        },
        {
            params: t.Object({
                id: t.String(),
                unitId: t.String(),
                page: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    );
