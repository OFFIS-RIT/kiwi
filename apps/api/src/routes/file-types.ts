import { FILE_TYPE_CHUNK_SIZE_MAX, FILE_TYPE_CHUNK_SIZE_MIN } from "@kiwi/contracts/file-types";
import { successResponse } from "@kiwi/contracts/errors";
import { GRAPH_DOCUMENT_MODES } from "@kiwi/loaders/loader/factory";
import Elysia from "elysia";
import z from "zod";
import { runApiAction } from "../controllers/_shared/api-effect";
import { listFileTypeConfigs, patchFileTypeConfig } from "../controllers/file-types/config";
import { authMiddleware } from "../middleware/auth";

const patchFileTypeConfigSchema = z.object({
    chunk_size: z.number().int().min(FILE_TYPE_CHUNK_SIZE_MIN).max(FILE_TYPE_CHUNK_SIZE_MAX).optional(),
    document_mode: z.enum(GRAPH_DOCUMENT_MODES).optional(),
});

export const fileTypesRoute = new Elysia({ prefix: "/file-types" })
    .use(authMiddleware)
    .get("/", ({ status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => listFileTypeConfigs({ user: currentUser }),
            success: (value) => status(200, successResponse(value)),
        })
    )
    .patch(
        "/:fileType",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => patchFileTypeConfig({ user: currentUser, fileType: params.fileType, body }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: z.object({
                fileType: z.string(),
            }),
            body: patchFileTypeConfigSchema,
        }
    );
