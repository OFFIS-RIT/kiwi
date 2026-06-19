import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Elysia } from "elysia";

const insertedPrompts: string[] = [];
const promptRowTimestamps = {
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    updatedAt: new Date("2026-01-02T03:04:06.000Z"),
};
let promptCount = 0;
let teamPromptError: Error | null = null;
let organizationPromptError: Error | null = null;
let graphPromptError: Error | null = null;

const transactionDb = {
    execute: () => Effect.succeed(undefined),
    select: () => ({
        from: () => ({
            where: () => ({
                limit: () =>
                    Effect.succeed(Array.from({ length: promptCount }, (_, index) => ({ id: `prompt-${index + 1}` }))),
            }),
        }),
    }),
    insert: () => ({
        values: (values: { prompt: string }) => ({
            returning: () =>
                Effect.sync(() => {
                    insertedPrompts.push(values.prompt);
                    return [
                        {
                            id: "prompt-1",
                            prompt: values.prompt,
                            ...promptRowTimestamps,
                        },
                    ];
                }),
        }),
    }),
};

const db = {
    transaction: (callback: (tx: typeof transactionDb) => unknown) => callback(transactionDb),
};

function runMockDbEffect(thunk: (database: typeof db) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(db);
    if (Effect.isEffect(result)) {
        return result;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        return Effect.promise(async () => await result);
    }
    return Effect.succeed(result);
}

mock.module("@kiwi/db/effect", () => ({
    DatabaseLayer: Layer.empty,
    tryDb: runMockDbEffect,
}));

mock.module("@kiwi/db", () => ({
    db,
}));

mock.module("../../lib/prompt-access", () => ({
    assertCanManageUserPrompts: () => Effect.succeed(undefined),
    assertCanManageTeamPrompts: () => (teamPromptError ? Effect.fail(teamPromptError) : Effect.succeed(undefined)),
    assertCanManageOrganizationPrompts: () =>
        organizationPromptError ? Effect.fail(organizationPromptError) : Effect.succeed(undefined),
    assertCanManageGraphPrompts: () =>
        graphPromptError
            ? Effect.fail(graphPromptError)
            : Effect.succeed({
                  id: "graph-1",
                  organizationId: "org-1",
                  teamId: null,
                  userId: "user-1",
                  graphId: null,
                  name: "Graph",
                  description: null,
                  hidden: false,
                  state: "ready",
              }),
}));

mock.module("../../lib/prompt-limits", () => ({
    MAX_PROMPT_LENGTH: 32,
    MAX_PROMPTS_PER_SCOPE: 2,
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
        user: {
            id: "user-1",
            email: "user@example.com",
            isSystemAdmin: false,
        },
    })),
}));

// Dynamic import is required because this test intentionally mocks route dependencies before module evaluation.
const { promptsRoute } = await import("../prompts");

describe("prompts route characterization", () => {
    beforeEach(() => {
        insertedPrompts.length = 0;
        promptCount = 0;
        teamPromptError = null;
        organizationPromptError = null;
        graphPromptError = null;
    });

    test("creating a user prompt trims input and returns prompt record fields", async () => {
        const response = await new Elysia().use(promptsRoute).handle(
            new Request("http://localhost/prompts/users/me", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "  Draft a release note.  " }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.status).toBe("success");
        expect(body.data).toEqual({
            id: "prompt-1",
            prompt: "Draft a release note.",
            created_at: promptRowTimestamps.createdAt.toISOString(),
            updated_at: promptRowTimestamps.updatedAt.toISOString(),
        });
        expect(insertedPrompts).toEqual(["Draft a release note."]);
    });

    test("blank prompt returns INVALID_PROMPT", async () => {
        const response = await new Elysia().use(promptsRoute).handle(
            new Request("http://localhost/prompts/users/me", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "   " }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.status).toBe("error");
        expect(body.code).toBe("INVALID_PROMPT");
        expect(insertedPrompts).toEqual([]);
    });

    test("max prompt count returns PROMPT_LIMIT_EXCEEDED", async () => {
        promptCount = 2;

        const response = await new Elysia().use(promptsRoute).handle(
            new Request("http://localhost/prompts/users/me", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "Keep this prompt" }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.status).toBe("error");
        expect(body.code).toBe("PROMPT_LIMIT_EXCEEDED");
        expect(insertedPrompts).toEqual([]);
    });

    test("team prompt authorization errors preserve FORBIDDEN", async () => {
        teamPromptError = new Error("FORBIDDEN");

        const response = await new Elysia().use(promptsRoute).handle(
            new Request("http://localhost/prompts/teams/team-1", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "Team prompt" }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.status).toBe("error");
        expect(body.code).toBe("FORBIDDEN");
    });

    test("organization prompt authorization errors preserve FORBIDDEN", async () => {
        organizationPromptError = new Error("FORBIDDEN");

        const response = await new Elysia().use(promptsRoute).handle(
            new Request("http://localhost/prompts/organizations/org-1", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "Organization prompt" }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.status).toBe("error");
        expect(body.code).toBe("FORBIDDEN");
    });

    test("graph prompt authorization errors preserve FORBIDDEN", async () => {
        graphPromptError = new Error("FORBIDDEN");

        const response = await new Elysia().use(promptsRoute).handle(
            new Request("http://localhost/prompts/graphs/graph-1", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "Graph prompt" }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.status).toBe("error");
        expect(body.code).toBe("FORBIDDEN");
    });
});
