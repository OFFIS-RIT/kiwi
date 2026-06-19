import { Elysia, t } from "elysia";
import { createChatTargetController, runChatTargetAction, type ChatRouteSpec } from "../controllers/chat/target-route";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { successResponse } from "../types";

const requestBodySchema = t.Union([
    t.Object({
        id: t.String(),
        message: t.Any(),
        deep: t.Optional(t.Boolean()),
        modelId: t.Optional(t.String()),
    }),
    t.Object({
        id: t.String(),
        messages: t.Array(t.Any()),
        deep: t.Optional(t.Boolean()),
        modelId: t.Optional(t.String()),
    }),
]);

export function createChatTargetRoute<TTarget>(spec: ChatRouteSpec<TTarget>) {
    const controller = createChatTargetController(spec);
    const beforeHandle = spec.permissions ? requirePermissions(spec.permissions) : () => undefined;
    const targetRoute = { beforeHandle, params: t.Object({ [spec.targetParam]: t.String() }) };
    const itemRoute = { beforeHandle, params: t.Object({ [spec.targetParam]: t.String(), chatId: t.String() }) };

    const route = new Elysia({ prefix: spec.prefix })
        .use(authMiddleware)
        .get(
            spec.listPath,
            ({ params, query, user, status }) =>
                runChatTargetAction({
                    user,
                    status,
                    mapError: controller.mapError,
                    action: (currentUser) => controller.listChats({ user: currentUser, params, query }),
                    success: (value) => status(200, successResponse(value)),
                }),
            {
                ...targetRoute,
                query: t.Object({
                    offset: t.Optional(t.String()),
                    limit: t.Optional(t.String()),
                }),
            }
        )
        .get(
            spec.itemPath,
            ({ params, user, status }) =>
                runChatTargetAction({
                    user,
                    status,
                    mapError: controller.mapError,
                    action: (currentUser) => controller.loadHistory({ user: currentUser, params }),
                    success: (value) => status(200, successResponse(value)),
                }),
            itemRoute
        )
        .delete(
            spec.itemPath,
            ({ params, user, status }) =>
                runChatTargetAction({
                    user,
                    status,
                    mapError: controller.mapError,
                    action: (currentUser) => controller.deleteChat({ user: currentUser, params }),
                    success: () => status(204, null),
                }),
            itemRoute
        );

    if (controller.pinningEnabled) {
        route
            .post(
                `${spec.itemPath}/pin`,
                ({ params, user, status }) =>
                    runChatTargetAction({
                        user,
                        status,
                        mapError: controller.mapError,
                        action: (currentUser) => controller.pinChat({ user: currentUser, params }),
                        success: () => status(204, null),
                    }),
                itemRoute
            )
            .post(
                `${spec.itemPath}/unpin`,
                ({ params, user, status }) =>
                    runChatTargetAction({
                        user,
                        status,
                        mapError: controller.mapError,
                        action: (currentUser) => controller.unpinChat({ user: currentUser, params }),
                        success: () => status(204, null),
                    }),
                itemRoute
            );
    }

    if (controller.archivingEnabled) {
        route
            .post(
                `${spec.itemPath}/archive`,
                ({ params, user, status }) =>
                    runChatTargetAction({
                        user,
                        status,
                        mapError: controller.mapError,
                        action: (currentUser) => controller.archiveChat({ user: currentUser, params }),
                        success: () => status(204, null),
                    }),
                itemRoute
            )
            .post(
                `${spec.itemPath}/unarchive`,
                ({ params, user, status }) =>
                    runChatTargetAction({
                        user,
                        status,
                        mapError: controller.mapError,
                        action: (currentUser) => controller.unarchiveChat({ user: currentUser, params }),
                        success: () => status(204, null),
                    }),
                itemRoute
            );
    }

    return route
        .post(
            spec.replyPath,
            ({ params, body, user, status, request: httpRequest }) =>
                runChatTargetAction({
                    user,
                    status,
                    mapError: controller.mapError,
                    action: (currentUser) =>
                        controller.completeReply({
                            user: currentUser,
                            params,
                            request: body,
                            abortSignal: httpRequest.signal,
                        }),
                    success: (value) => status(200, successResponse(value)),
                }),
            { ...targetRoute, body: requestBodySchema }
        )
        .post(
            spec.streamPath,
            ({ params, body, user, status, request: httpRequest }) =>
                runChatTargetAction({
                    user,
                    status,
                    mapError: controller.mapError,
                    action: (currentUser) =>
                        controller.streamReply({
                            user: currentUser,
                            params,
                            request: body,
                            abortSignal: httpRequest.signal,
                        }),
                    success: (value) => value,
                }),
            { ...targetRoute, body: requestBodySchema }
        );
}
