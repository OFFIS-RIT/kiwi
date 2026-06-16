import { Elysia, t } from "elysia";
import * as Effect from "effect/Effect";
import { successResponse } from "@kiwi/contracts/errors";
import { binaryResponse } from "../lib/binary-response";
import { mapApiError, runApiAction, type RouteStatus } from "../controllers/_shared/api-effect";
import { getGraphFileUrl } from "../controllers/graph/files/get-url";
import { getSourceReference } from "../controllers/graph/files/source-reference";
import { getSourceReferenceImage } from "../controllers/graph/files/source-reference-image";
import { getTextUnit } from "../controllers/graph/files/text-unit";
import { listGraphFiles } from "../controllers/graph/files/list";
import { listSourceReferences } from "../controllers/graph/files/source-references";
import { redirectToNamedGraphFile } from "../controllers/graph/files/redirect-to-named";
import { renderTextUnitPage } from "../controllers/graph/files/render-page";
import { serveGraphFile, type ServeGraphFileResult } from "../controllers/graph/files/serve";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";

type FileParams = { id: string; fileId: string };

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

function runFileProxyAction<T>(options: {
    status: RouteStatus;
    action: Effect.Effect<T, unknown>;
    success: (value: T) => unknown;
}) {
    return Effect.runPromise(
        Effect.match(options.action, {
            onFailure: (error) => mapApiError(options.status, error),
            onSuccess: options.success,
        })
    );
}

function proxyResponse(result: ServeGraphFileResult) {
    if (result.status === "invalid_range") {
        return new Response(null, {
            status: 416,
            headers: {
                "Accept-Ranges": "bytes",
                "Content-Range": `bytes */${result.size}`,
            },
        });
    }

    return result.response;
}

function serveFile(params: FileParams, request: Request, user: AuthUser | null | undefined, head = false) {
    return serveGraphFile({
        graphId: params.id,
        fileId: params.fileId,
        request,
        user,
        head,
    });
}

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
            runFileProxyAction({
                status,
                action: serveFile(params, request, user),
                success: proxyResponse,
            }),
        {
            params: namedGraphFileParamsSchema,
        }
    )
    .head(
        "/:id/files/:fileId/:filename",
        ({ params, request, user, status }) =>
            runFileProxyAction({
                status,
                action: serveFile(params, request, user, true),
                success: proxyResponse,
            }),
        {
            params: namedGraphFileParamsSchema,
        }
    )
    .get(
        "/:id/files/:fileId",
        ({ params, request, user, status }) =>
            runFileProxyAction({
                status,
                action: redirectToNamedGraphFile({
                    graphId: params.id,
                    fileId: params.fileId,
                    request,
                    user,
                }),
                success: (location) => new Response(null, { status: 307, headers: { Location: location } }),
            }),
        {
            params: graphFileParamsSchema,
        }
    )
    .head(
        "/:id/files/:fileId",
        ({ params, request, user, status }) =>
            runFileProxyAction({
                status,
                action: redirectToNamedGraphFile({
                    graphId: params.id,
                    fileId: params.fileId,
                    request,
                    user,
                }),
                success: (location) => new Response(null, { status: 307, headers: { Location: location } }),
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
                action: (currentUser) => getGraphFileUrl({ user: currentUser, graphId: params.id, fileKey: body.file_key }),
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
                    renderTextUnitPage({ user: currentUser, graphId: params.id, unitId: params.unitId, page: params.page }),
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
