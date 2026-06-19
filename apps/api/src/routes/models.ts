import Elysia, { t } from "elysia";
import { ModelCreateInputSchema, ModelPatchInputSchema, ModelQuerySchema } from "@kiwi/contracts/models";
import { successResponse } from "@kiwi/contracts/errors";
import { asApiSchema } from "@kiwi/contracts/schema";
import { runApiAction } from "../controllers/_shared/api-effect";
import { createModel } from "../controllers/models/create-model";
import { deleteModel } from "../controllers/models/delete-model";
import { listModels } from "../controllers/models/list-models";
import { patchModel } from "../controllers/models/patch-model";
import { setDefaultModel } from "../controllers/models/set-default-model";
import { authMiddleware } from "../middleware/auth";

const modelIdParamsSchema = t.Object({ modelId: t.String() });

export const modelsRoute = new Elysia({ prefix: "/models" })
    .use(authMiddleware)
    .get(
        "/",
        ({ query, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listModels({ user: currentUser, query }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            query: asApiSchema(ModelQuerySchema),
        }
    )
    .post(
        "/",
        ({ body, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => createModel({ user: currentUser, body }),
                success: (value) => status(201, successResponse(value)),
            }),
        {
            body: asApiSchema(ModelCreateInputSchema),
        }
    )
    .patch(
        "/:modelId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => patchModel({ user: currentUser, modelId: params.modelId, body }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: modelIdParamsSchema,
            body: asApiSchema(ModelPatchInputSchema),
        }
    )
    .post(
        "/:modelId/default",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => setDefaultModel({ user: currentUser, modelId: params.modelId }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: modelIdParamsSchema,
        }
    )
    .delete(
        "/:modelId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => deleteModel({ user: currentUser, modelId: params.modelId }),
                success: () => status(204, null),
            }),
        {
            params: modelIdParamsSchema,
        }
    );
