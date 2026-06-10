import { db } from "@kiwi/db";
import { chatTable } from "@kiwi/db/tables/chats";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { mapChatError, setChatArchived, setChatPinned, type ChatRequest } from "../lib/chat";
import { createChatStreamResponse, runChatCompletion, type StartedChatReply } from "../lib/chat-response";
import { parseListNumber } from "../lib/parse-query-params";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

type RouteStatus = (code: number, body: unknown) => unknown;
type RouteParams = Record<string, string | undefined>;

type ChatRouteSpec<TTarget> = {
    prefix?: string;
    targetParam: string;
    listPath: string;
    itemPath: string;
    replyPath: string;
    streamPath: string;
    permissions?: KiwiPermissions;
    libraryActions?: {
        pin?: boolean;
        archive?: boolean;
    };
    mapError?: (status: RouteStatus, error: unknown) => unknown;
    resolveTarget: (user: AuthUser, targetId: string) => Promise<TTarget>;
    listChats: (userId: string, target: TTarget, options: { offset?: number; limit?: number }) => Promise<unknown>;
    loadHistory: (userId: string, target: TTarget, chatId: string) => Promise<unknown>;
    loadSummary: (userId: string, target: TTarget, chatId: string) => Promise<{ id: string }>;
    startReply: (options: {
        user: AuthUser;
        target: TTarget;
        request: ChatRequest;
        mode: "completion" | "stream";
        abortSignal: AbortSignal;
    }) => Promise<StartedChatReply>;
};

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

function targetParams(targetParam: string) {
    return t.Object({ [targetParam]: t.String() });
}

function itemParams(targetParam: string) {
    return t.Object({ [targetParam]: t.String(), chatId: t.String() });
}

function getParam(params: RouteParams, name: string) {
    const value = params[name];
    if (!value) {
        throw new Error(API_ERROR_CODES.INVALID_CHAT_REQUEST);
    }

    return value;
}

async function runChatAction<T>(options: {
    user: AuthUser | null;
    status: RouteStatus;
    mapError: (status: RouteStatus, error: unknown) => unknown;
    action: (user: AuthUser) => Promise<T>;
    success: (value: T) => unknown;
}) {
    const user = options.user;
    if (!user) {
        return options.status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
    }

    const result = await Result.tryPromise(async () => options.action(user));
    if (result.isErr()) {
        return options.mapError(options.status, result.error);
    }

    return options.success(result.value);
}

export function createChatTargetRoute<TTarget>(spec: ChatRouteSpec<TTarget>) {
    const mapError = spec.mapError ?? mapChatError;
    const beforeHandle = spec.permissions ? requirePermissions(spec.permissions) : () => undefined;
    const targetRoute = { beforeHandle, params: targetParams(spec.targetParam) };
    const itemRoute = { beforeHandle, params: itemParams(spec.targetParam) };
    const pinningEnabled = spec.libraryActions?.pin ?? true;
    const archivingEnabled = spec.libraryActions?.archive ?? true;

    const resolveTarget = async (user: AuthUser, params: RouteParams) => {
        const targetId = getParam(params, spec.targetParam);
        return spec.resolveTarget(user, targetId);
    };

    const loadChat = async (user: AuthUser, params: RouteParams) => {
        const target = await resolveTarget(user, params);
        return spec.loadSummary(user.id, target, getParam(params, "chatId"));
    };

    const mutateChat = async (
        user: AuthUser,
        params: RouteParams,
        update: (chatId: string, userId: string) => Promise<void>
    ) => {
        const chat = await loadChat(user, params);
        await update(chat.id, user.id);
    };

    const route = new Elysia({ prefix: spec.prefix })
        .use(authMiddleware)
        .get(
            spec.listPath,
            async ({ params, query, user, status }) =>
                runChatAction({
                    user,
                    status,
                    mapError,
                    action: async (currentUser) => {
                        const target = await resolveTarget(currentUser, params);
                        return spec.listChats(currentUser.id, target, {
                            offset: parseListNumber(query.offset, { minimum: 0, maximum: 10_000 }),
                            limit: parseListNumber(query.limit, { minimum: 1, maximum: 100 }),
                        });
                    },
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
            async ({ params, user, status }) =>
                runChatAction({
                    user,
                    status,
                    mapError,
                    action: async (currentUser) => {
                        const target = await resolveTarget(currentUser, params);
                        return spec.loadHistory(currentUser.id, target, getParam(params, "chatId"));
                    },
                    success: (value) => status(200, successResponse(value)),
                }),
            itemRoute
        )
        .delete(
            spec.itemPath,
            async ({ params, user, status }) =>
                runChatAction({
                    user,
                    status,
                    mapError,
                    action: async (currentUser) => {
                        const chat = await loadChat(currentUser, params);
                        await db.delete(chatTable).where(eq(chatTable.id, chat.id));
                    },
                    success: () => status(204, null),
                }),
            itemRoute
        );

    if (pinningEnabled) {
        route
            .post(
                `${spec.itemPath}/pin`,
                async ({ params, user, status }) =>
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            mutateChat(currentUser, params, (chatId, userId) => setChatPinned(chatId, userId, true)),
                        success: () => status(204, null),
                    }),
                itemRoute
            )
            .post(
                `${spec.itemPath}/unpin`,
                async ({ params, user, status }) =>
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            mutateChat(currentUser, params, (chatId, userId) => setChatPinned(chatId, userId, false)),
                        success: () => status(204, null),
                    }),
                itemRoute
            );
    }

    if (archivingEnabled) {
        route
            .post(
                `${spec.itemPath}/archive`,
                async ({ params, user, status }) =>
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            mutateChat(currentUser, params, (chatId, userId) => setChatArchived(chatId, userId, true)),
                        success: () => status(204, null),
                    }),
                itemRoute
            )
            .post(
                `${spec.itemPath}/unarchive`,
                async ({ params, user, status }) =>
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            mutateChat(currentUser, params, (chatId, userId) => setChatArchived(chatId, userId, false)),
                        success: () => status(204, null),
                    }),
                itemRoute
            );
    }

    return route
        .post(
            spec.replyPath,
            async ({ params, body, user, status, request: httpRequest }) =>
                runChatAction({
                    user,
                    status,
                    mapError,
                    action: async (currentUser) => {
                        const request = body as ChatRequest;
                        const target = await resolveTarget(currentUser, params);
                        const reply = await spec.startReply({
                            user: currentUser,
                            target,
                            request,
                            mode: "completion",
                            abortSignal: httpRequest.signal,
                        });

                        return runChatCompletion(reply);
                    },
                    success: (value) => status(200, successResponse(value)),
                }),
            { ...targetRoute, body: requestBodySchema }
        )
        .post(
            spec.streamPath,
            async ({ params, body, user, status, request: httpRequest }) =>
                runChatAction({
                    user,
                    status,
                    mapError,
                    action: async (currentUser) => {
                        const request = body as ChatRequest;
                        const target = await resolveTarget(currentUser, params);
                        const reply = await spec.startReply({
                            user: currentUser,
                            target,
                            request,
                            mode: "stream",
                            abortSignal: httpRequest.signal,
                        });

                        return createChatStreamResponse(reply);
                    },
                    success: (value) => value,
                }),
            { ...targetRoute, body: requestBodySchema }
        );
}
