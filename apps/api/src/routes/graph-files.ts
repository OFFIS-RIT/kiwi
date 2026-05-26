import { and, asc, eq } from "drizzle-orm";
import { Result } from "better-result";
import { Elysia, t } from "elysia";
import { db } from "@kiwi/db";
import { filesTable } from "@kiwi/db/tables/graph";
import { error as logError } from "@kiwi/logger";
import { env } from "../env";
import { verifyProjectFileAccessToken } from "../lib/project-file-access-token";
import { assertCanViewGraph } from "../lib/graph-access";
import { getGraphFileProxyResponse, loadGraphFileByKey } from "../lib/graph-file-proxy";
import { mapGraphError, selectGraphDetailFileFields, toGraphFileRecord, type GraphFileRow } from "../lib/graph-route";
import { getOrRenderPDFPreviewPage } from "../lib/pdf-preview-cache";
import { getProjectFileProxyPath } from "../lib/project-file-url";
import { getPdfPreviewPageNumbers, parsePageImageParam } from "../lib/text-unit-preview";
import { isPageInsideUnitSpan, loadTextUnitWithFile, pngResponse, toTextUnitRecord } from "../lib/text-unit-record";
import { mapUnitError } from "../lib/unit";
import { authMiddleware } from "../middleware/auth";
import { assertPermissions, requirePermissions } from "../middleware/permissions";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

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
        "/:id/files/:fileId",
        async ({ params, request, user, status }) => {
            const accessToken = new URL(request.url).searchParams.get("token");
            const hasTokenAccess = await verifyProjectFileAccessToken(accessToken, params.id, params.fileId);

            const proxyResult = await Result.tryPromise(async () => {
                if (!hasTokenAccess) {
                    if (!user) {
                        throw new Error(API_ERROR_CODES.UNAUTHORIZED);
                    }

                    await assertPermissions(request.headers, { graph: ["view"] });
                    await assertCanViewGraph(user, params.id);
                }

                return getGraphFileProxyResponse({
                    graphId: params.id,
                    fileId: params.fileId,
                    request,
                    bucket: env.S3_BUCKET,
                });
            });

            if (proxyResult.isErr()) {
                if (proxyResult.error instanceof Error && proxyResult.error.message === API_ERROR_CODES.UNAUTHORIZED) {
                    return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
                }

                return mapGraphError(status, proxyResult.error);
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
        },
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

                return status(200, successResponse({ url: getProjectFileProxyPath(params.id, file.id) }));
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
            if (!isPageInsideUnitSpan(unit, page)) {
                return status(422, errorResponse("Invalid page range", API_ERROR_CODES.INVALID_PAGE_RANGE));
            }

            try {
                const preview = await getOrRenderPDFPreviewPage({
                    graphId: params.id,
                    fileId: unit.project_file_id,
                    fileKey: unit.file_key,
                    page,
                    pagesToRender: getPdfPreviewPageNumbers(unit.start_page!, unit.end_page!),
                    bucket: env.S3_BUCKET,
                });
                if (preview.status === "source_missing") {
                    return status(404, errorResponse("File not found", API_ERROR_CODES.INVALID_FILE_IDS));
                }

                return pngResponse(preview.content);
            } catch (error) {
                logError("failed to render PDF text unit preview", {
                    graphId: params.id,
                    unitId: params.unitId,
                    fileId: unit.project_file_id,
                    page,
                    error,
                });

                return status(
                    500,
                    errorResponse("Failed to render PDF preview", API_ERROR_CODES.INTERNAL_SERVER_ERROR)
                );
            }
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
