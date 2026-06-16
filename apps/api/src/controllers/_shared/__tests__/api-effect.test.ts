import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { forbiddenError, graphNotFoundError, invalidPromptError } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../../middleware/auth";
import { connectorApiErrorOptions, mapApiError, runApiAction } from "../api-effect";

const user = {
    id: "user-1",
    email: "user@example.com",
    activeOrganizationId: "org-1",
    activeTeamId: null,
    isSystemAdmin: false,
} as AuthUser;

describe("runApiAction", () => {
    test("maps success values", async () => {
        const response = await runApiAction({
            status: (code, body) => ({ code, body }),
            user,
            action: () => Effect.succeed({ ok: true }),
            success: (value) => ({ code: 200, body: value }),
        });

        expect(response).toEqual({ code: 200, body: { ok: true } });
    });

    test("returns unauthorized before running the action", async () => {
        const response = await runApiAction({
            status: (code, body) => ({ code, body }),
            user: null,
            action: () => Effect.succeed("ignored"),
            success: (value) => ({ code: 200, body: value }),
        });

        expect(response).toEqual({
            code: 401,
            body: {
                status: "error",
                message: "Unauthorized",
                code: "UNAUTHORIZED",
            },
        });
    });

    test("maps typed api failures", async () => {
        const response = await runApiAction({
            status: (code, body) => ({ code, body }),
            user,
            action: () => Effect.fail(forbiddenError()),
            success: (value) => ({ code: 200, body: value }),
        });

        expect(response).toEqual({
            code: 403,
            body: {
                status: "error",
                message: "Forbidden",
                code: "FORBIDDEN",
            },
        });
    });

    test("maps legacy sentinel errors", () => {
        expect(mapApiError((code, body) => ({ code, body }), new Error("Unhandled exception: GRAPH_NOT_FOUND"))).toEqual({
            code: 404,
            body: {
                status: "error",
                message: "Graph not found",
                code: "GRAPH_NOT_FOUND",
            },
        });
    });

    test("preserves connector fallback errors", () => {
        expect(
            mapApiError(
                (code, body) => ({ code, body }),
                new Error("Provider rejected request"),
                connectorApiErrorOptions
            )
        ).toEqual({
            code: 400,
            body: {
                status: "error",
                message: "Provider rejected request",
                code: "INVALID_CHAT_REQUEST",
            },
        });
    });

    test("preserves connector legacy graph not found message", () => {
        expect(
            mapApiError(
                (code, body) => ({ code, body }),
                new Error("GRAPH_NOT_FOUND"),
                connectorApiErrorOptions
            )
        ).toEqual({
            code: 404,
            body: {
                status: "error",
                message: "Not found",
                code: "GRAPH_NOT_FOUND",
            },
        });
    });

    test("keeps validation failures at 400", async () => {
        const response = await runApiAction({
            status: (code, body) => ({ code, body }),
            user,
            action: () => Effect.fail(invalidPromptError()),
            success: (value) => ({ code: 200, body: value }),
        });

        expect(response).toEqual({
            code: 400,
            body: {
                status: "error",
                message: "Invalid prompt",
                code: "INVALID_PROMPT",
            },
        });
    });

    test("keeps not found failures at 404", async () => {
        const response = await runApiAction({
            status: (code, body) => ({ code, body }),
            user,
            action: () => Effect.fail(graphNotFoundError()),
            success: (value) => ({ code: 200, body: value }),
        });

        expect(response).toEqual({
            code: 404,
            body: {
                status: "error",
                message: "Graph not found",
                code: "GRAPH_NOT_FOUND",
            },
        });
    });

    test("falls back to 500 for unknown failures", async () => {
        const response = await runApiAction({
            status: (code, body) => ({ code, body }),
            user,
            action: () => Effect.fail(new Error("boom")),
            success: (value) => ({ code: 200, body: value }),
        });

        expect(response).toEqual({
            code: 500,
            body: {
                status: "error",
                message: "Internal server error",
                code: "INTERNAL_SERVER_ERROR",
            },
        });
    });
});
