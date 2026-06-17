import { DatabaseLayer, tryDbVoid, type Database } from "@kiwi/db/effect";
import { chatTable } from "@kiwi/db/tables/chats";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
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
    resolveTarget: (user: AuthUser, targetId: string) => Effect.Effect<TTarget, unknown, Database>;
    listChats: (
        userId: string,
        target: TTarget,
        options: { offset?: number; limit?: number }
    ) => Effect.Effect<unknown, unknown, Database>;
    loadHistory: (userId: string, target: TTarget, chatId: string) => Effect.Effect<unknown, unknown, Database>;
    loadSummary: (userId: string, target: TTarget, chatId: string) => Effect.Effect<{ id: string }, unknown, Database>;
    startReply: (options: {
        user: AuthUser;
        target: TTarget;
        request: ChatRequest;
        mode: "completion" | "stream";
        abortSignal: AbortSignal;
    }) => Effect.Effect<StartedChatReply, unknown, Database>;
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

function runChatAction<T>(options: {
    user: AuthUser | null;
    status: RouteStatus;
    mapError: (status: RouteStatus, error: unknown) => unknown;
    action: (user: AuthUser) => Effect.Effect<T, unknown, Database>;
    success: (value: T) => unknown;
}) {
    const user = options.user;
    if (!user) {
        return Effect.succeed(options.status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED)));
    }

    return Effect.provide(
        Effect.match(options.action(user), {
            onFailure: (error) => options.mapError(options.status, error),
            onSuccess: options.success,
        }),
        DatabaseLayer
    );
}

export function createChatTargetRoute<TTarget>(spec: ChatRouteSpec<TTarget>) {
    const mapError = spec.mapError ?? mapChatError;
    const beforeHandle = spec.permissions ? requirePermissions(spec.permissions) : () => undefined;
    const targetRoute = { beforeHandle, params: targetParams(spec.targetParam) };
    const itemRoute = { beforeHandle, params: itemParams(spec.targetParam) };
    const pinningEnabled = spec.libraryActions?.pin ?? true;
    const archivingEnabled = spec.libraryActions?.archive ?? true;

    const resolveTarget = (user: AuthUser, params: RouteParams): Effect.Effect<TTarget, unknown, Database> =>
        Effect.gen(function* () {
            const targetId = yield* Effect.try({
                try: () => getParam(params, spec.targetParam),
                catch: (error) => error,
            });
            return yield* spec.resolveTarget(user, targetId);
        });

    const loadChat = (
        user: AuthUser,
        params: RouteParams
    ): Effect.Effect<{ id: string }, unknown, Database> =>
        Effect.gen(function* () {
            const target = yield* resolveTarget(user, params);
            const chatId = yield* Effect.try({
                try: () => getParam(params, "chatId"),
                catch: (error) => error,
            });
            return yield* spec.loadSummary(user.id, target, chatId);
        });

    const mutateChat = (
        user: AuthUser,
        params: RouteParams,
        update: (chatId: string, userId: string) => Effect.Effect<void, unknown, Database>
    ): Effect.Effect<void, unknown, Database> =>
        Effect.gen(function* () {
            const chat = yield* loadChat(user, params);
            yield* update(chat.id, user.id);
        });

    const route = new Elysia({ prefix: spec.prefix })
        .use(authMiddleware)
        .get(
            spec.listPath,
            async ({ params, query, user, status }) =>
                Effect.runPromise(
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            Effect.gen(function* () {
                                const target = yield* resolveTarget(currentUser, params);
                                const offset = yield* Effect.try({
                                    try: () => parseListNumber(query.offset, { minimum: 0, maximum: 10_000 }),
                                    catch: (error) => error,
                                });
                                const limit = yield* Effect.try({
                                    try: () => parseListNumber(query.limit, { minimum: 1, maximum: 100 }),
                                    catch: (error) => error,
                                });

                                return yield* spec.listChats(currentUser.id, target, {
                                    offset,
                                    limit,
                                });
                            }),
                        success: (value) => status(200, successResponse(value)),
                    })
                ),
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
                Effect.runPromise(
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            Effect.gen(function* () {
                                const target = yield* resolveTarget(currentUser, params);
                                const chatId = yield* Effect.try({
                                    try: () => getParam(params, "chatId"),
                                    catch: (error) => error,
                                });
                                return yield* spec.loadHistory(currentUser.id, target, chatId);
                            }),
                        success: (value) => status(200, successResponse(value)),
                    })
                ),
            itemRoute
        )
        .delete(
            spec.itemPath,
            async ({ params, user, status }) =>
                Effect.runPromise(
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            Effect.gen(function* () {
                                const chat = yield* loadChat(currentUser, params);
                                yield* tryDbVoid((db) => db.delete(chatTable).where(eq(chatTable.id, chat.id)));
                            }),
                        success: () => status(204, null),
                    })
                ),
            itemRoute
        );

    if (pinningEnabled) {
        route
            .post(
                `${spec.itemPath}/pin`,
                async ({ params, user, status }) =>
                    Effect.runPromise(
                        runChatAction({
                            user,
                            status,
                            mapError,
                            action: (currentUser) =>
                                mutateChat(currentUser, params, (chatId, userId) => setChatPinned(chatId, userId, true)),
                            success: () => status(204, null),
                        })
                    ),
                itemRoute
            )
            .post(
                `${spec.itemPath}/unpin`,
                async ({ params, user, status }) =>
                    Effect.runPromise(
                        runChatAction({
                            user,
                            status,
                            mapError,
                            action: (currentUser) =>
                                mutateChat(currentUser, params, (chatId, userId) => setChatPinned(chatId, userId, false)),
                            success: () => status(204, null),
                        })
                    ),
                itemRoute
            );
    }

    if (archivingEnabled) {
        route
            .post(
                `${spec.itemPath}/archive`,
                async ({ params, user, status }) =>
                    Effect.runPromise(
                        runChatAction({
                            user,
                            status,
                            mapError,
                            action: (currentUser) =>
                                mutateChat(currentUser, params, (chatId, userId) => setChatArchived(chatId, userId, true)),
                            success: () => status(204, null),
                        })
                    ),
                itemRoute
            )
            .post(
                `${spec.itemPath}/unarchive`,
                async ({ params, user, status }) =>
                    Effect.runPromise(
                        runChatAction({
                            user,
                            status,
                            mapError,
                            action: (currentUser) =>
                                mutateChat(currentUser, params, (chatId, userId) => setChatArchived(chatId, userId, false)),
                            success: () => status(204, null),
                        })
                    ),
                itemRoute
            );
    }

    return route
        .post(
            spec.replyPath,
            async ({ params, body, user, status, request: httpRequest }) =>
                Effect.runPromise(
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            Effect.gen(function* () {
                                const request = body as ChatRequest;
                                const target = yield* resolveTarget(currentUser, params);
                                const reply = yield* spec.startReply({
                                    user: currentUser,
                                    target,
                                    request,
                                    mode: "completion",
                                    abortSignal: httpRequest.signal,
                                });

                                return yield* runChatCompletion(reply);
                            }),
                        success: (value) => status(200, successResponse(value)),
                    })
                ),
            { ...targetRoute, body: requestBodySchema }
        )
        .post(
            spec.streamPath,
            async ({ params, body, user, status, request: httpRequest }) =>
                Effect.runPromise(
                    runChatAction({
                        user,
                        status,
                        mapError,
                        action: (currentUser) =>
                            Effect.gen(function* () {
                                const request = body as ChatRequest;
                                const target = yield* resolveTarget(currentUser, params);
                                const reply = yield* spec.startReply({
                                    user: currentUser,
                                    target,
                                    request,
                                    mode: "stream",
                                    abortSignal: httpRequest.signal,
                                });

                                return yield* Effect.try({
                                    try: () => createChatStreamResponse(reply),
                                    catch: (error) => error,
                                });
                            }),
                        success: (value) => value,
                    })
                ),
            { ...targetRoute, body: requestBodySchema }
        );
}
