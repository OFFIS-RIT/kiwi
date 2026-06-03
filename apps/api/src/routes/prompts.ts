import { db } from "@kiwi/db";
import { teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
    assertCanManageGraphPrompts,
    assertCanManageTeamPrompts,
    assertCanManageUserPrompts,
} from "../lib/prompt-access";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

const MAX_PROMPT_LENGTH = 20_000;

type RouteStatus = (code: number, body: unknown) => unknown;

type PromptRecord = {
    id: string;
    prompt: string;
    createdAt: Date | null;
    updatedAt: Date | null;
};

type PromptDeleteRecord = {
    id: string;
};

function mapPromptError(status: RouteStatus, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    switch (error.message) {
        case API_ERROR_CODES.FORBIDDEN:
            return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
        case API_ERROR_CODES.GRAPH_NOT_FOUND:
            return status(404, errorResponse("Graph not found", API_ERROR_CODES.GRAPH_NOT_FOUND));
        case API_ERROR_CODES.INVALID_GRAPH_OWNER:
            return status(400, errorResponse("Invalid graph owner chain", API_ERROR_CODES.INVALID_GRAPH_OWNER));
        case API_ERROR_CODES.TEAM_NOT_FOUND:
            return status(404, errorResponse("Team not found", API_ERROR_CODES.TEAM_NOT_FOUND));
        case API_ERROR_CODES.PROMPT_NOT_FOUND:
            return status(404, errorResponse("Prompt not found", API_ERROR_CODES.PROMPT_NOT_FOUND));
        case API_ERROR_CODES.INVALID_PROMPT:
            return status(400, errorResponse("Invalid prompt", API_ERROR_CODES.INVALID_PROMPT));
        default:
            return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }
}

function normalizePrompt(prompt: string) {
    const normalized = prompt.trim();
    if (normalized.length === 0 || normalized.length > MAX_PROMPT_LENGTH) {
        throw new Error(API_ERROR_CODES.INVALID_PROMPT);
    }

    return normalized;
}

function toPromptResponse(row: PromptRecord) {
    return {
        id: row.id,
        prompt: row.prompt,
        created_at: row.createdAt?.toISOString() ?? null,
        updated_at: row.updatedAt?.toISOString() ?? null,
    };
}

function resolveUserId(currentUserId: string, userId: string) {
    return userId === "me" ? currentUserId : userId;
}

async function runPromptAction<T>(
    status: RouteStatus,
    user: AuthUser | null | undefined,
    action: (user: AuthUser) => Promise<T>
) {
    if (!user) {
        return {
            ok: false as const,
            response: status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED)),
        };
    }

    const result = await Result.tryPromise(async () => action(user));
    if (result.isErr()) {
        return {
            ok: false as const,
            response: mapPromptError(status, result.error),
        };
    }

    return {
        ok: true as const,
        value: result.value,
    };
}

async function listPromptResponse(
    status: RouteStatus,
    user: AuthUser | null | undefined,
    loadPrompts: (user: AuthUser) => Promise<PromptRecord[]>
) {
    const response = await runPromptAction(status, user, async (currentUser) =>
        (await loadPrompts(currentUser)).map(toPromptResponse)
    );

    if (!response.ok) {
        return response.response;
    }

    return status(200, successResponse(response.value));
}

async function writePromptResponse(
    status: RouteStatus,
    user: AuthUser | null | undefined,
    rawPrompt: string,
    successStatus: 200 | 201,
    missingCode: string,
    writePrompt: (user: AuthUser, prompt: string) => Promise<PromptRecord | undefined>
) {
    const response = await runPromptAction(status, user, async (currentUser) => {
        const row = await writePrompt(currentUser, normalizePrompt(rawPrompt));
        if (!row) {
            throw new Error(missingCode);
        }

        return toPromptResponse(row);
    });

    if (!response.ok) {
        return response.response;
    }

    return status(successStatus, successResponse(response.value));
}

async function deletePromptResponse(
    status: RouteStatus,
    user: AuthUser | null | undefined,
    deletePrompt: (user: AuthUser) => Promise<PromptDeleteRecord | undefined>
) {
    const response = await runPromptAction(status, user, async (currentUser) => {
        const row = await deletePrompt(currentUser);
        if (!row) {
            throw new Error(API_ERROR_CODES.PROMPT_NOT_FOUND);
        }
    });

    if (!response.ok) {
        return response.response;
    }

    return status(204, null);
}

const promptBody = t.Object({
    prompt: t.String(),
});

const userPromptFields = {
    id: userPromptsTable.id,
    prompt: userPromptsTable.prompt,
    createdAt: userPromptsTable.createdAt,
    updatedAt: userPromptsTable.updatedAt,
};

const teamPromptFields = {
    id: teamPromptsTable.id,
    prompt: teamPromptsTable.prompt,
    createdAt: teamPromptsTable.createdAt,
    updatedAt: teamPromptsTable.updatedAt,
};

const graphPromptFields = {
    id: graphPromptsTable.id,
    prompt: graphPromptsTable.prompt,
    createdAt: graphPromptsTable.createdAt,
    updatedAt: graphPromptsTable.updatedAt,
};

export const promptsRoute = new Elysia({ prefix: "/prompts" })
    .use(authMiddleware)
    .get(
        "/users/:userId",
        ({ params, status, user }) =>
            listPromptResponse(status, user, async (currentUser) => {
                const userId = resolveUserId(currentUser.id, params.userId);
                await assertCanManageUserPrompts(currentUser, userId);

                return db
                    .select(userPromptFields)
                    .from(userPromptsTable)
                    .where(eq(userPromptsTable.userId, userId))
                    .orderBy(asc(userPromptsTable.createdAt), asc(userPromptsTable.id));
            }),
        {
            params: t.Object({
                userId: t.String(),
            }),
        }
    )
    .post(
        "/users/:userId",
        ({ body, params, status, user }) =>
            writePromptResponse(
                status,
                user,
                body.prompt,
                201,
                API_ERROR_CODES.INTERNAL_SERVER_ERROR,
                async (currentUser, prompt) => {
                    const userId = resolveUserId(currentUser.id, params.userId);
                    await assertCanManageUserPrompts(currentUser, userId);

                    const [row] = await db
                        .insert(userPromptsTable)
                        .values({ userId, prompt })
                        .returning(userPromptFields);
                    return row;
                }
            ),
        {
            params: t.Object({
                userId: t.String(),
            }),
            body: promptBody,
        }
    )
    .patch(
        "/users/:userId/:promptId",
        ({ body, params, status, user }) =>
            writePromptResponse(
                status,
                user,
                body.prompt,
                200,
                API_ERROR_CODES.PROMPT_NOT_FOUND,
                async (currentUser, prompt) => {
                    const userId = resolveUserId(currentUser.id, params.userId);
                    await assertCanManageUserPrompts(currentUser, userId);

                    const [row] = await db
                        .update(userPromptsTable)
                        .set({ prompt })
                        .where(and(eq(userPromptsTable.id, params.promptId), eq(userPromptsTable.userId, userId)))
                        .returning(userPromptFields);
                    return row;
                }
            ),
        {
            params: t.Object({
                userId: t.String(),
                promptId: t.String(),
            }),
            body: promptBody,
        }
    )
    .delete(
        "/users/:userId/:promptId",
        ({ params, status, user }) =>
            deletePromptResponse(status, user, async (currentUser) => {
                const userId = resolveUserId(currentUser.id, params.userId);
                await assertCanManageUserPrompts(currentUser, userId);

                const [row] = await db
                    .delete(userPromptsTable)
                    .where(and(eq(userPromptsTable.id, params.promptId), eq(userPromptsTable.userId, userId)))
                    .returning({ id: userPromptsTable.id });
                return row;
            }),
        {
            params: t.Object({
                userId: t.String(),
                promptId: t.String(),
            }),
        }
    )
    .get(
        "/teams/:teamId",
        ({ params, status, user }) =>
            listPromptResponse(status, user, async (currentUser) => {
                await assertCanManageTeamPrompts(currentUser, params.teamId);

                return db
                    .select(teamPromptFields)
                    .from(teamPromptsTable)
                    .where(eq(teamPromptsTable.teamId, params.teamId))
                    .orderBy(asc(teamPromptsTable.createdAt), asc(teamPromptsTable.id));
            }),
        {
            params: t.Object({
                teamId: t.String(),
            }),
        }
    )
    .post(
        "/teams/:teamId",
        ({ body, params, status, user }) =>
            writePromptResponse(
                status,
                user,
                body.prompt,
                201,
                API_ERROR_CODES.INTERNAL_SERVER_ERROR,
                async (currentUser, prompt) => {
                    await assertCanManageTeamPrompts(currentUser, params.teamId);

                    const [row] = await db
                        .insert(teamPromptsTable)
                        .values({ teamId: params.teamId, prompt })
                        .returning(teamPromptFields);
                    return row;
                }
            ),
        {
            params: t.Object({
                teamId: t.String(),
            }),
            body: promptBody,
        }
    )
    .patch(
        "/teams/:teamId/:promptId",
        ({ body, params, status, user }) =>
            writePromptResponse(
                status,
                user,
                body.prompt,
                200,
                API_ERROR_CODES.PROMPT_NOT_FOUND,
                async (currentUser, prompt) => {
                    await assertCanManageTeamPrompts(currentUser, params.teamId);

                    const [row] = await db
                        .update(teamPromptsTable)
                        .set({ prompt })
                        .where(
                            and(eq(teamPromptsTable.id, params.promptId), eq(teamPromptsTable.teamId, params.teamId))
                        )
                        .returning(teamPromptFields);
                    return row;
                }
            ),
        {
            params: t.Object({
                teamId: t.String(),
                promptId: t.String(),
            }),
            body: promptBody,
        }
    )
    .delete(
        "/teams/:teamId/:promptId",
        ({ params, status, user }) =>
            deletePromptResponse(status, user, async (currentUser) => {
                await assertCanManageTeamPrompts(currentUser, params.teamId);

                const [row] = await db
                    .delete(teamPromptsTable)
                    .where(and(eq(teamPromptsTable.id, params.promptId), eq(teamPromptsTable.teamId, params.teamId)))
                    .returning({ id: teamPromptsTable.id });
                return row;
            }),
        {
            params: t.Object({
                teamId: t.String(),
                promptId: t.String(),
            }),
        }
    )
    .get(
        "/graphs/:graphId",
        ({ params, status, user }) =>
            listPromptResponse(status, user, async (currentUser) => {
                await assertCanManageGraphPrompts(currentUser, params.graphId);

                return db
                    .select(graphPromptFields)
                    .from(graphPromptsTable)
                    .where(eq(graphPromptsTable.graphId, params.graphId))
                    .orderBy(asc(graphPromptsTable.createdAt), asc(graphPromptsTable.id));
            }),
        {
            params: t.Object({
                graphId: t.String(),
            }),
        }
    )
    .post(
        "/graphs/:graphId",
        ({ body, params, status, user }) =>
            writePromptResponse(
                status,
                user,
                body.prompt,
                201,
                API_ERROR_CODES.INTERNAL_SERVER_ERROR,
                async (currentUser, prompt) => {
                    await assertCanManageGraphPrompts(currentUser, params.graphId);

                    const [row] = await db
                        .insert(graphPromptsTable)
                        .values({ graphId: params.graphId, prompt })
                        .returning(graphPromptFields);
                    return row;
                }
            ),
        {
            params: t.Object({
                graphId: t.String(),
            }),
            body: promptBody,
        }
    )
    .patch(
        "/graphs/:graphId/:promptId",
        ({ body, params, status, user }) =>
            writePromptResponse(
                status,
                user,
                body.prompt,
                200,
                API_ERROR_CODES.PROMPT_NOT_FOUND,
                async (currentUser, prompt) => {
                    await assertCanManageGraphPrompts(currentUser, params.graphId);

                    const [row] = await db
                        .update(graphPromptsTable)
                        .set({ prompt })
                        .where(
                            and(
                                eq(graphPromptsTable.id, params.promptId),
                                eq(graphPromptsTable.graphId, params.graphId)
                            )
                        )
                        .returning(graphPromptFields);
                    return row;
                }
            ),
        {
            params: t.Object({
                graphId: t.String(),
                promptId: t.String(),
            }),
            body: promptBody,
        }
    )
    .delete(
        "/graphs/:graphId/:promptId",
        ({ params, status, user }) =>
            deletePromptResponse(status, user, async (currentUser) => {
                await assertCanManageGraphPrompts(currentUser, params.graphId);

                const [row] = await db
                    .delete(graphPromptsTable)
                    .where(
                        and(eq(graphPromptsTable.id, params.promptId), eq(graphPromptsTable.graphId, params.graphId))
                    )
                    .returning({ id: graphPromptsTable.id });
                return row;
            }),
        {
            params: t.Object({
                graphId: t.String(),
                promptId: t.String(),
            }),
        }
    );
