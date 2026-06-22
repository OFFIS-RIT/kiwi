import { tryDbVoid, type Database } from "@kiwi/db/effect";
import { chatTable } from "@kiwi/db/tables/chats";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { mapChatError, setChatArchived, setChatPinned, type ChatRequest } from "../../lib/chat";
import { createChatStreamResponse, runChatCompletion, type StartedChatReply } from "../../lib/chat-response";
import { parseListNumber } from "../../lib/parse-query-params";
import type { AuthUser } from "../../middleware/auth";
import { API_ERROR_CODES, makeApiError } from "../../types";
import { runApiAction, type RouteStatus } from "../_shared/api-effect";
import type { ApiServices } from "../../effect";

export type ChatRouteParams = Record<string, string | undefined>;
export type ChatRouteQuery = {
    offset?: string;
    limit?: string;
};

export type ChatRouteSpec<TTarget> = {
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
    }) => Effect.Effect<StartedChatReply, unknown, ApiServices>;
};

function getParam(params: ChatRouteParams, name: string) {
    const value = params[name];
    return value
        ? Effect.succeed(value)
        : Effect.fail(makeApiError(400, API_ERROR_CODES.INVALID_CHAT_REQUEST, "Invalid chat request"));
}

export function runChatTargetAction<T>(options: {
    user: AuthUser | null | undefined;
    status: RouteStatus;
    mapError: (status: RouteStatus, error: unknown) => unknown;
    action: (user: AuthUser) => Effect.Effect<T, unknown, ApiServices>;
    success: (value: T) => unknown;
}) {
    return runApiAction({
        user: options.user,
        status: options.status,
        action: options.action,
        success: options.success,
        mapError: options.mapError,
    });
}

export function createChatTargetController<TTarget>(spec: ChatRouteSpec<TTarget>) {
    const mapError = spec.mapError ?? mapChatError;

    const resolveTarget: (user: AuthUser, params: ChatRouteParams) => Effect.Effect<TTarget, unknown, Database> =
        Effect.fn("ChatTargetController.resolveTarget")(function* (user: AuthUser, params: ChatRouteParams) {
            const targetId = yield* getParam(params, spec.targetParam);
            return yield* spec.resolveTarget(user, targetId);
        });

    const loadChat: (user: AuthUser, params: ChatRouteParams) => Effect.Effect<{ id: string }, unknown, Database> =
        Effect.fn("ChatTargetController.loadChat")(function* (user: AuthUser, params: ChatRouteParams) {
            const target = yield* resolveTarget(user, params);
            const chatId = yield* getParam(params, "chatId");
            return yield* spec.loadSummary(user.id, target, chatId);
        });

    const mutateChat: (
        user: AuthUser,
        params: ChatRouteParams,
        update: (chatId: string, userId: string) => Effect.Effect<void, unknown, Database>
    ) => Effect.Effect<void, unknown, Database> = Effect.fn("ChatTargetController.mutateChat")(function* (
        user: AuthUser,
        params: ChatRouteParams,
        update: (chatId: string, userId: string) => Effect.Effect<void, unknown, Database>
    ) {
        const chat = yield* loadChat(user, params);
        yield* update(chat.id, user.id);
    });

    const startReply: (options: {
        user: AuthUser;
        params: ChatRouteParams;
        request: ChatRequest;
        mode: "completion" | "stream";
        abortSignal: AbortSignal;
    }) => Effect.Effect<StartedChatReply, unknown, ApiServices> = Effect.fn("ChatTargetController.startReply")(
        function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
            request: ChatRequest;
            mode: "completion" | "stream";
            abortSignal: AbortSignal;
        }) {
            const target = yield* resolveTarget(options.user, options.params);
            return yield* spec.startReply({
                user: options.user,
                target,
                request: options.request,
                mode: options.mode,
                abortSignal: options.abortSignal,
            });
        }
    );

    return {
        mapError,
        pinningEnabled: spec.libraryActions?.pin ?? true,
        archivingEnabled: spec.libraryActions?.archive ?? true,
        listChats: Effect.fn("ChatTargetController.listChats")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
            query: ChatRouteQuery;
        }) {
            const target = yield* resolveTarget(options.user, options.params);
            const offset = yield* Effect.try({
                try: () => parseListNumber(options.query.offset, { minimum: 0, maximum: 10_000 }),
                catch: (error) => error,
            });
            const limit = yield* Effect.try({
                try: () => parseListNumber(options.query.limit, { minimum: 1, maximum: 100 }),
                catch: (error) => error,
            });

            return yield* spec.listChats(options.user.id, target, { offset, limit });
        }),
        loadHistory: Effect.fn("ChatTargetController.loadHistory")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
        }) {
            const target = yield* resolveTarget(options.user, options.params);
            const chatId = yield* getParam(options.params, "chatId");
            return yield* spec.loadHistory(options.user.id, target, chatId);
        }),
        deleteChat: Effect.fn("ChatTargetController.deleteChat")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
        }) {
            const chat = yield* loadChat(options.user, options.params);
            yield* tryDbVoid((db) => db.delete(chatTable).where(eq(chatTable.id, chat.id)));
        }),
        pinChat: Effect.fn("ChatTargetController.pinChat")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
        }) {
            yield* mutateChat(options.user, options.params, (chatId, userId) => setChatPinned(chatId, userId, true));
        }),
        unpinChat: Effect.fn("ChatTargetController.unpinChat")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
        }) {
            yield* mutateChat(options.user, options.params, (chatId, userId) => setChatPinned(chatId, userId, false));
        }),
        archiveChat: Effect.fn("ChatTargetController.archiveChat")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
        }) {
            yield* mutateChat(options.user, options.params, (chatId, userId) => setChatArchived(chatId, userId, true));
        }),
        unarchiveChat: Effect.fn("ChatTargetController.unarchiveChat")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
        }) {
            yield* mutateChat(options.user, options.params, (chatId, userId) => setChatArchived(chatId, userId, false));
        }),
        completeReply: Effect.fn("ChatTargetController.completeReply")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
            request: ChatRequest;
            abortSignal: AbortSignal;
        }) {
            const reply = yield* startReply({ ...options, mode: "completion" });
            return yield* runChatCompletion(reply);
        }),
        streamReply: Effect.fn("ChatTargetController.streamReply")(function* (options: {
            user: AuthUser;
            params: ChatRouteParams;
            request: ChatRequest;
            abortSignal: AbortSignal;
        }) {
            const reply = yield* startReply({ ...options, mode: "stream" });
            return yield* Effect.try({
                try: () => createChatStreamResponse(reply),
                catch: (error) => error,
            });
        }),
    };
}
