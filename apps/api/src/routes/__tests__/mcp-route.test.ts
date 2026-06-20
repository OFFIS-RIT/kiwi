import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import type { AuthSession, AuthUser } from "../../middleware/auth";

const testUser = { id: "user-1", email: "user@example.com", isSystemAdmin: false } as AuthUser;
const testSession: NonNullable<AuthSession> = {
    user: { id: testUser.id, email: testUser.email },
    session: { id: "session-1" },
};
let currentUser: AuthUser | null = testUser;
let currentSession: AuthSession = testSession;
let receivedContext: { request: Request; session: AuthSession; user: AuthUser | null | undefined } | undefined;

const testMcpAuthPlugin = new Elysia({ name: "test-mcp-auth" }).derive({ as: "scoped" }, () => ({
    session: currentSession,
    user: currentUser,
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: testMcpAuthPlugin,
    mcpAuthMiddleware: testMcpAuthPlugin,
}));

mock.module("../../controllers/mcp/handle-request", () => ({
    handleMcpRouteRequest: (context: { request: Request; session: AuthSession; user: AuthUser | null | undefined }) => {
        receivedContext = context;
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    },
}));

// Dynamic import is required so Bun module mocks are installed before the route module is evaluated.
const { mcpRoute } = await import("../mcp");

describe("mcp route", () => {
    beforeEach(() => {
        currentUser = testUser;
        currentSession = testSession;
        receivedContext = undefined;
    });

    test("passes authenticated POST requests to the MCP controller", async () => {
        const request = new Request("http://localhost/mcp/", { method: "POST", body: "{}" });
        const response = await new Elysia().use(mcpRoute).handle(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(receivedContext?.request).toBe(request);
        expect(receivedContext?.session).toBe(testSession);
        expect(receivedContext?.user).toBe(testUser);
    });

    test("returns JSON-RPC method-not-allowed responses without controller dispatch", async () => {
        const response = await new Elysia().use(mcpRoute).handle(new Request("http://localhost/mcp/"));
        const body = await response.json();

        expect(response.status).toBe(405);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(body).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
        expect(receivedContext).toBeUndefined();
    });
});
