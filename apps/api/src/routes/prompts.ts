import { Elysia, t } from "elysia";
import { successResponse } from "@kiwi/contracts/errors";
import { PromptBodySchema } from "@kiwi/contracts/prompts";
import { asApiSchema } from "@kiwi/contracts/schema";
import { runApiAction } from "../controllers/_shared/api-effect";
import { createPrompt } from "../controllers/prompts/create-prompt";
import { deletePrompt } from "../controllers/prompts/delete-prompt";
import { listPrompts } from "../controllers/prompts/list-prompts";
import { patchPrompt } from "../controllers/prompts/patch-prompt";
import { authMiddleware } from "../middleware/auth";

const promptBodyTransportSchema = asApiSchema(PromptBodySchema);
const userParamsSchema = t.Object({ userId: t.String() });
const userPromptParamsSchema = t.Object({ userId: t.String(), promptId: t.String() });
const teamParamsSchema = t.Object({ teamId: t.String() });
const teamPromptParamsSchema = t.Object({ teamId: t.String(), promptId: t.String() });
const organizationParamsSchema = t.Object({ organizationId: t.String() });
const organizationPromptParamsSchema = t.Object({ organizationId: t.String(), promptId: t.String() });
const graphParamsSchema = t.Object({ graphId: t.String() });
const graphPromptParamsSchema = t.Object({ graphId: t.String(), promptId: t.String() });

export const promptsRoute = new Elysia({ prefix: "/prompts" })
    .use(authMiddleware)
    .get(
        "/users/:userId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listPrompts({ user: currentUser, scope: { kind: "user", userId: params.userId } }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: userParamsSchema }
    )
    .post(
        "/users/:userId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createPrompt({
                        user: currentUser,
                        scope: { kind: "user", userId: params.userId },
                        prompt: body.prompt,
                    }),
                success: (value) => status(201, successResponse(value)),
            }),
        { params: userParamsSchema, body: promptBodyTransportSchema }
    )
    .patch(
        "/users/:userId/:promptId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    patchPrompt({
                        user: currentUser,
                        scope: { kind: "user", userId: params.userId },
                        promptId: params.promptId,
                        prompt: body.prompt,
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: userPromptParamsSchema, body: promptBodyTransportSchema }
    )
    .delete(
        "/users/:userId/:promptId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    deletePrompt({
                        user: currentUser,
                        scope: { kind: "user", userId: params.userId },
                        promptId: params.promptId,
                    }),
                success: () => status(200, successResponse(null)),
            }),
        { params: userPromptParamsSchema }
    )
    .get(
        "/teams/:teamId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listPrompts({ user: currentUser, scope: { kind: "team", teamId: params.teamId } }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: teamParamsSchema }
    )
    .post(
        "/teams/:teamId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createPrompt({
                        user: currentUser,
                        scope: { kind: "team", teamId: params.teamId },
                        prompt: body.prompt,
                    }),
                success: (value) => status(201, successResponse(value)),
            }),
        { params: teamParamsSchema, body: promptBodyTransportSchema }
    )
    .patch(
        "/teams/:teamId/:promptId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    patchPrompt({
                        user: currentUser,
                        scope: { kind: "team", teamId: params.teamId },
                        promptId: params.promptId,
                        prompt: body.prompt,
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: teamPromptParamsSchema, body: promptBodyTransportSchema }
    )
    .delete(
        "/teams/:teamId/:promptId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    deletePrompt({
                        user: currentUser,
                        scope: { kind: "team", teamId: params.teamId },
                        promptId: params.promptId,
                    }),
                success: () => status(200, successResponse(null)),
            }),
        { params: teamPromptParamsSchema }
    )
    .get(
        "/organizations/:organizationId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    listPrompts({ user: currentUser, scope: { kind: "organization", organizationId: params.organizationId } }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: organizationParamsSchema }
    )
    .post(
        "/organizations/:organizationId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createPrompt({
                        user: currentUser,
                        scope: { kind: "organization", organizationId: params.organizationId },
                        prompt: body.prompt,
                    }),
                success: (value) => status(201, successResponse(value)),
            }),
        { params: organizationParamsSchema, body: promptBodyTransportSchema }
    )
    .patch(
        "/organizations/:organizationId/:promptId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    patchPrompt({
                        user: currentUser,
                        scope: { kind: "organization", organizationId: params.organizationId },
                        promptId: params.promptId,
                        prompt: body.prompt,
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: organizationPromptParamsSchema, body: promptBodyTransportSchema }
    )
    .delete(
        "/organizations/:organizationId/:promptId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    deletePrompt({
                        user: currentUser,
                        scope: { kind: "organization", organizationId: params.organizationId },
                        promptId: params.promptId,
                    }),
                success: () => status(200, successResponse(null)),
            }),
        { params: organizationPromptParamsSchema }
    )
    .get(
        "/graphs/:graphId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listPrompts({ user: currentUser, scope: { kind: "graph", graphId: params.graphId } }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: graphParamsSchema }
    )
    .post(
        "/graphs/:graphId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createPrompt({
                        user: currentUser,
                        scope: { kind: "graph", graphId: params.graphId },
                        prompt: body.prompt,
                    }),
                success: (value) => status(201, successResponse(value)),
            }),
        { params: graphParamsSchema, body: promptBodyTransportSchema }
    )
    .patch(
        "/graphs/:graphId/:promptId",
        ({ body, params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    patchPrompt({
                        user: currentUser,
                        scope: { kind: "graph", graphId: params.graphId },
                        promptId: params.promptId,
                        prompt: body.prompt,
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        { params: graphPromptParamsSchema, body: promptBodyTransportSchema }
    )
    .delete(
        "/graphs/:graphId/:promptId",
        ({ params, status, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    deletePrompt({
                        user: currentUser,
                        scope: { kind: "graph", graphId: params.graphId },
                        promptId: params.promptId,
                    }),
                success: () => status(200, successResponse(null)),
            }),
        { params: graphPromptParamsSchema }
    );
