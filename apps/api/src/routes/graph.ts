import { Elysia, t } from "elysia";
import {
    GraphAddUrlFieldsSchema,
    GraphCreateFieldsSchema,
    GraphDeleteFilesFieldsSchema,
    GraphPatchFieldsSchema,
} from "@kiwi/contracts/graphs";
import { successResponse } from "@kiwi/contracts/errors";
import { asApiSchema, decodeApiSchemaSync } from "@kiwi/contracts/schema";
import { addGraphFiles } from "../controllers/graph/add-files";
import { addGraphRepositoryUrls } from "../controllers/graph/add-repository-urls";
import { createGraph } from "../controllers/graph/create";
import { deleteGraph } from "../controllers/graph/delete";
import { deleteGraphFiles } from "../controllers/graph/delete-files";
import { getGraph } from "../controllers/graph/get";
import { listGraphs } from "../controllers/graph/list";
import { patchGraph } from "../controllers/graph/patch";
import { retryGraphFile } from "../controllers/graph/retry-file";
import { runApiAction } from "../controllers/_shared/api-effect";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";

const decodeGraphCreateFields = decodeApiSchemaSync(GraphCreateFieldsSchema);

export const graphRoute = new Elysia({ prefix: "/graphs" })
    .use(authMiddleware)
    .get(
        "/",
        ({ user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listGraphs({ user: currentUser }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .get(
        "/:id",
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => getGraph({ user: currentUser, graphId: params.id }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .post(
        "/",
        ({ body, user, status }) => {
            const { files: rawFiles, ...fieldInput } = body;

            return runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createGraph({
                        user: currentUser,
                        fields: decodeGraphCreateFields(fieldInput),
                        files: rawFiles ? (Array.isArray(rawFiles) ? rawFiles : [rawFiles]) : [],
                    }),
                success: (value) => status(201, successResponse(value)),
            });
        },
        {
            body: t.Object(
                {
                    files: t.Optional(t.Files()),
                },
                { additionalProperties: true }
            ),
        }
    )
    .patch(
        "/:id",
        ({ body, params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => patchGraph({ user: currentUser, graphId: params.id, body }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
            }),
            body: asApiSchema(GraphPatchFieldsSchema),
        }
    )
    .post(
        "/:id/urls",
        ({ body, params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    addGraphRepositoryUrls({
                        user: currentUser,
                        graphId: params.id,
                        body: { urls: [...body.urls] },
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
            }),
            body: asApiSchema(GraphAddUrlFieldsSchema),
        }
    )
    .post(
        "/:id/files",
        ({ body, params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    addGraphFiles({
                        user: currentUser,
                        graphId: params.id,
                        files: body.files ? (Array.isArray(body.files) ? body.files : [body.files]) : [],
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
            }),
            body: t.Object({
                files: t.Optional(t.Files()),
            }),
        }
    )
    .post(
        "/:id/files/:fileId/retry",
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => retryGraphFile({ user: currentUser, graphId: params.id, fileId: params.fileId }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
                fileId: t.String(),
            }),
        }
    )
    .delete(
        "/:id/files",
        ({ body, params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    deleteGraphFiles({
                        user: currentUser,
                        graphId: params.id,
                        body: {
                            fileKeys:
                                body.fileKeys === undefined || typeof body.fileKeys === "string"
                                    ? body.fileKeys
                                    : [...body.fileKeys],
                        },
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
            }),
            body: asApiSchema(GraphDeleteFilesFieldsSchema),
        }
    )
    .delete(
        "/:id",
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => deleteGraph({ user: currentUser, graphId: params.id }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
            }),
        }
    );
