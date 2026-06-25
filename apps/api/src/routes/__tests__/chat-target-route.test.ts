import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Elysia } from "elysia";
import type { ChatRouteSpec } from "../../controllers/chat/target-route";
import type { AuthUser } from "../../middleware/auth";

const testUser = {
    id: "user-1",
    email: "user@example.com",
    activeOrganizationId: "org-1",
    activeTeamId: null,
    isSystemAdmin: false,
} as AuthUser;
let currentUser: AuthUser | null = testUser;
const listCalls: Array<{ userId: string; graphId: string; offset?: number; limit?: number }> = [];

const Database = Context.Service<unknown>("@kiwi/db/Database");

mock.module("@kiwi/db/effect", () => ({
    Database,
    DatabaseError: class DatabaseError extends Error {},
    DatabaseLayer: Layer.empty,
    tryDbVoid: () => Effect.void,
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
}));

const testAuthPlugin = new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
    session: currentUser ? { id: "session-1" } : null,
    user: currentUser,
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: testAuthPlugin,
    mcpAuthMiddleware: testAuthPlugin,
}));

mock.module("../../middleware/permissions", () => ({
    requirePermissions: () => () => undefined,
}));

mock.module("../../lib/chat", () => ({
    mapChatError: (status: (code: number, body: unknown) => unknown, error: unknown) =>
        status(500, { status: "error", message: error instanceof Error ? error.message : "Internal server error" }),
    setChatArchived: () => Effect.void,
    setChatPinned: () => Effect.void,
}));

mock.module("../../lib/chat-response", () => ({
    createChatStreamResponse: () => new Response(),
    runChatCompletion: () => Effect.succeed({}),
}));

mock.module("@kiwi/ai/models", () => ({
    AiModelRegistry: Effect.succeed({}),
    makeAiModelRegistryLayer: () => Layer.empty,
}));

// Dynamic import is required so Bun module mocks are installed before the route module is evaluated.
const { createChatTargetRoute } = await import("../chat-target-route");

const spec: ChatRouteSpec<{ graphId: string }> = {
    prefix: "/test-graphs",
    targetParam: "graphId",
    listPath: "/:graphId/chats",
    itemPath: "/:graphId/chats/:chatId",
    replyPath: "/:graphId/chats/reply",
    streamPath: "/:graphId/chats/stream",
    resolveTarget: (_user, graphId) => Effect.succeed({ graphId }),
    listChats: (userId, target, options) => {
        listCalls.push({ userId, graphId: target.graphId, offset: options.offset, limit: options.limit });
        return Effect.succeed({ items: [{ id: "chat-1" }], hasMore: false, nextOffset: null });
    },
    loadHistory: (_userId, _target, chatId) => Effect.succeed([{ id: chatId, role: "user" }]),
    loadSummary: (_userId, _target, chatId) => Effect.succeed({ id: chatId }),
    startReply: () => Effect.succeed({} as never),
};

describe("chat target route", () => {
    beforeEach(() => {
        currentUser = testUser;
        listCalls.length = 0;
    });

    test("runs list actions through the shared Effect route adapter", async () => {
        const response = await new Elysia()
            .use(createChatTargetRoute(spec))
            .handle(new Request("http://localhost/test-graphs/graph-1/chats?offset=2&limit=3"));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            status: "success",
            data: { items: [{ id: "chat-1" }], hasMore: false, nextOffset: null },
        });
        expect(listCalls).toEqual([{ userId: "user-1", graphId: "graph-1", offset: 2, limit: 3 }]);
    });

    test("rejects unauthenticated requests before running the action", async () => {
        currentUser = null;

        const response = await new Elysia()
            .use(createChatTargetRoute(spec))
            .handle(new Request("http://localhost/test-graphs/graph-1/chats"));
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body).toEqual({ status: "error", message: "Unauthorized", code: "UNAUTHORIZED" });
        expect(listCalls).toEqual([]);
    });
});
