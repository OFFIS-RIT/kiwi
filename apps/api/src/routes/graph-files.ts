import { Elysia, t } from "elysia";
import { successResponse } from "@kiwi/contracts/errors";
import { binaryResponse } from "../lib/binary-response";
import { runApiAction } from "../controllers/_shared/api-effect";
import { getGraphFileUrl } from "../controllers/graph/files/get-url";
import { getSourceReference } from "../controllers/graph/files/source-reference";
import { getSourceReferenceImage } from "../controllers/graph/files/source-reference-image";
import { getTextUnit } from "../controllers/graph/files/text-unit";
import { listGraphFiles } from "../controllers/graph/files/list";
import { listSourceReferences } from "../controllers/graph/files/source-references";
import { redirectToNamedGraphFileResponse } from "../controllers/graph/files/redirect-to-named";
import { renderTextUnitPage } from "../controllers/graph/files/render-page";
import { serveGraphFileResponse } from "../controllers/graph/files/serve";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";

const graphParamsSchema = t.Object({ id: t.String() });
const graphFileParamsSchema = t.Object({
    id: t.String(),
    fileId: t.String(),
});
const namedGraphFileParamsSchema = t.Object({
    id: t.String(),
    fileId: t.String(),
    filename: t.String(),
});
export const graphFilesRoute = new Elysia({ prefix: "/graphs" })
    .use(authMiddleware)
    .get(
        "/:id/files",
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listGraphFiles({ user: currentUser, graphId: params.id }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: graphParamsSchema,
            beforeHandle: requirePermissions({
                graph: ["list:file"],
            }),
        }
    )
    .get(
        "/:id/files/:fileId/:filename",
        ({ params, request, user, status }) =>
            serveGraphFileResponse({
                graphId: params.id,
                fileId: params.fileId,
                request,
                user,
                status,
            }),
        {
            params: namedGraphFileParamsSchema,
        }
    )
    .head(
        "/:id/files/:fileId/:filename",
        ({ params, request, user, status }) =>
            serveGraphFileResponse({
                graphId: params.id,
                fileId: params.fileId,
                request,
                user,
                status,
                head: true,
            }),
        {
            params: namedGraphFileParamsSchema,
        }
    )
    .get(
        "/:id/files/:fileId",
        ({ params, request, user, status }) =>
            redirectToNamedGraphFileResponse({
                graphId: params.id,
                fileId: params.fileId,
                request,
                user,
                status,
            }),
        {
            params: graphFileParamsSchema,
        }
    )
    .head(
        "/:id/files/:fileId",
        ({ params, request, user, status }) =>
            redirectToNamedGraphFileResponse({
                graphId: params.id,
                fileId: params.fileId,
                request,
                user,
                status,
            }),
        {
            params: graphFileParamsSchema,
        }
    )
    .post(
        "/:id/file",
        ({ body, params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    getGraphFileUrl({ user: currentUser, graphId: params.id, fileKey: body.file_key }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: graphParamsSchema,
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
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    getSourceReferenceImage({
                        user: currentUser,
                        graphId: params.id,
                        sourceId: params.sourceId,
                        chunkId: params.chunkId,
                    }),
                success: (image) => binaryResponse(image.content, { contentType: image.contentType }),
            }),
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
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    getSourceReference({ user: currentUser, graphId: params.id, sourceId: params.sourceId }),
                success: (value) => status(200, successResponse(value)),
            }),
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
        ({ body, params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    listSourceReferences({ user: currentUser, graphId: params.id, sourceIds: body.source_ids }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: graphParamsSchema,
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
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => getTextUnit({ user: currentUser, graphId: params.id, unitId: params.unitId }),
                success: (value) => status(200, successResponse(value)),
            }),
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
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    renderTextUnitPage({
                        user: currentUser,
                        graphId: params.id,
                        unitId: params.unitId,
                        page: params.page,
                    }),
                success: (content) => binaryResponse(content, { contentType: "image/png" }),
            }),
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
