import { db } from "@kiwi/db";
import { teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../middleware/auth";
import {
    assertCanManageGraphPrompts,
    assertCanManageTeamPrompts,
    assertCanManageUserPrompts,
} from "../lib/prompt-access";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

const MAX_PROMPT_LENGTH = 20_000;

type RouteStatus = (code: number, body: unknown) => unknown;

type PromptRecord = {
    id: string;
    prompt: string;
    createdAt: Date | null;
    updatedAt: Date | null;
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

const promptBody = t.Object({
    prompt: t.String(),
});

export const promptsRoute = new Elysia({ prefix: "/prompts" })
    .use(authMiddleware)
    .get(
        "/users/:userId",
        async ({ params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const promptsResult = await Result.tryPromise(async () => {
                const userId = resolveUserId(user.id, params.userId);
                await assertCanManageUserPrompts(user, userId);

                const rows = await db
                    .select({
                        id: userPromptsTable.id,
                        prompt: userPromptsTable.prompt,
                        createdAt: userPromptsTable.createdAt,
                        updatedAt: userPromptsTable.updatedAt,
                    })
                    .from(userPromptsTable)
                    .where(eq(userPromptsTable.userId, userId))
                    .orderBy(asc(userPromptsTable.createdAt), asc(userPromptsTable.id));

                return rows.map(toPromptResponse);
            });

            if (promptsResult.isErr()) {
                return mapPromptError(status, promptsResult.error);
            }

            return status(200, successResponse(promptsResult.value));
        },
        {
            params: t.Object({
                userId: t.String(),
            }),
        }
    )
    .post(
        "/users/:userId",
        async ({ body, params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const createResult = await Result.tryPromise(async () => {
                const userId = resolveUserId(user.id, params.userId);
                await assertCanManageUserPrompts(user, userId);
                const prompt = normalizePrompt(body.prompt);

                const [row] = await db.insert(userPromptsTable).values({ userId, prompt }).returning({
                    id: userPromptsTable.id,
                    prompt: userPromptsTable.prompt,
                    createdAt: userPromptsTable.createdAt,
                    updatedAt: userPromptsTable.updatedAt,
                });

                if (!row) {
                    throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
                }

                return toPromptResponse(row);
            });

            if (createResult.isErr()) {
                return mapPromptError(status, createResult.error);
            }

            return status(201, successResponse(createResult.value));
        },
        {
            params: t.Object({
                userId: t.String(),
            }),
            body: promptBody,
        }
    )
    .patch(
        "/users/:userId/:promptId",
        async ({ body, params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const updateResult = await Result.tryPromise(async () => {
                const userId = resolveUserId(user.id, params.userId);
                await assertCanManageUserPrompts(user, userId);
                const prompt = normalizePrompt(body.prompt);

                const [row] = await db
                    .update(userPromptsTable)
                    .set({ prompt })
                    .where(and(eq(userPromptsTable.id, params.promptId), eq(userPromptsTable.userId, userId)))
                    .returning({
                        id: userPromptsTable.id,
                        prompt: userPromptsTable.prompt,
                        createdAt: userPromptsTable.createdAt,
                        updatedAt: userPromptsTable.updatedAt,
                    });

                if (!row) {
                    throw new Error(API_ERROR_CODES.PROMPT_NOT_FOUND);
                }

                return toPromptResponse(row);
            });

            if (updateResult.isErr()) {
                return mapPromptError(status, updateResult.error);
            }

            return status(200, successResponse(updateResult.value));
        },
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
        async ({ params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const deleteResult = await Result.tryPromise(async () => {
                const userId = resolveUserId(user.id, params.userId);
                await assertCanManageUserPrompts(user, userId);

                const [row] = await db
                    .delete(userPromptsTable)
                    .where(and(eq(userPromptsTable.id, params.promptId), eq(userPromptsTable.userId, userId)))
                    .returning({ id: userPromptsTable.id });

                if (!row) {
                    throw new Error(API_ERROR_CODES.PROMPT_NOT_FOUND);
                }
            });

            if (deleteResult.isErr()) {
                return mapPromptError(status, deleteResult.error);
            }

            return status(204, null);
        },
        {
            params: t.Object({
                userId: t.String(),
                promptId: t.String(),
            }),
        }
    )
    .get(
        "/teams/:teamId",
        async ({ params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const promptsResult = await Result.tryPromise(async () => {
                await assertCanManageTeamPrompts(user, params.teamId);

                const rows = await db
                    .select({
                        id: teamPromptsTable.id,
                        prompt: teamPromptsTable.prompt,
                        createdAt: teamPromptsTable.createdAt,
                        updatedAt: teamPromptsTable.updatedAt,
                    })
                    .from(teamPromptsTable)
                    .where(eq(teamPromptsTable.teamId, params.teamId))
                    .orderBy(asc(teamPromptsTable.createdAt), asc(teamPromptsTable.id));

                return rows.map(toPromptResponse);
            });

            if (promptsResult.isErr()) {
                return mapPromptError(status, promptsResult.error);
            }

            return status(200, successResponse(promptsResult.value));
        },
        {
            params: t.Object({
                teamId: t.String(),
            }),
        }
    )
    .post(
        "/teams/:teamId",
        async ({ body, params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const createResult = await Result.tryPromise(async () => {
                await assertCanManageTeamPrompts(user, params.teamId);
                const prompt = normalizePrompt(body.prompt);

                const [row] = await db.insert(teamPromptsTable).values({ teamId: params.teamId, prompt }).returning({
                    id: teamPromptsTable.id,
                    prompt: teamPromptsTable.prompt,
                    createdAt: teamPromptsTable.createdAt,
                    updatedAt: teamPromptsTable.updatedAt,
                });

                if (!row) {
                    throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
                }

                return toPromptResponse(row);
            });

            if (createResult.isErr()) {
                return mapPromptError(status, createResult.error);
            }

            return status(201, successResponse(createResult.value));
        },
        {
            params: t.Object({
                teamId: t.String(),
            }),
            body: promptBody,
        }
    )
    .patch(
        "/teams/:teamId/:promptId",
        async ({ body, params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const updateResult = await Result.tryPromise(async () => {
                await assertCanManageTeamPrompts(user, params.teamId);
                const prompt = normalizePrompt(body.prompt);

                const [row] = await db
                    .update(teamPromptsTable)
                    .set({ prompt })
                    .where(and(eq(teamPromptsTable.id, params.promptId), eq(teamPromptsTable.teamId, params.teamId)))
                    .returning({
                        id: teamPromptsTable.id,
                        prompt: teamPromptsTable.prompt,
                        createdAt: teamPromptsTable.createdAt,
                        updatedAt: teamPromptsTable.updatedAt,
                    });

                if (!row) {
                    throw new Error(API_ERROR_CODES.PROMPT_NOT_FOUND);
                }

                return toPromptResponse(row);
            });

            if (updateResult.isErr()) {
                return mapPromptError(status, updateResult.error);
            }

            return status(200, successResponse(updateResult.value));
        },
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
        async ({ params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const deleteResult = await Result.tryPromise(async () => {
                await assertCanManageTeamPrompts(user, params.teamId);

                const [row] = await db
                    .delete(teamPromptsTable)
                    .where(and(eq(teamPromptsTable.id, params.promptId), eq(teamPromptsTable.teamId, params.teamId)))
                    .returning({ id: teamPromptsTable.id });

                if (!row) {
                    throw new Error(API_ERROR_CODES.PROMPT_NOT_FOUND);
                }
            });

            if (deleteResult.isErr()) {
                return mapPromptError(status, deleteResult.error);
            }

            return status(204, null);
        },
        {
            params: t.Object({
                teamId: t.String(),
                promptId: t.String(),
            }),
        }
    )
    .get(
        "/graphs/:graphId",
        async ({ params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const promptsResult = await Result.tryPromise(async () => {
                await assertCanManageGraphPrompts(user, params.graphId);

                const rows = await db
                    .select({
                        id: graphPromptsTable.id,
                        prompt: graphPromptsTable.prompt,
                        createdAt: graphPromptsTable.createdAt,
                        updatedAt: graphPromptsTable.updatedAt,
                    })
                    .from(graphPromptsTable)
                    .where(eq(graphPromptsTable.graphId, params.graphId))
                    .orderBy(asc(graphPromptsTable.createdAt), asc(graphPromptsTable.id));

                return rows.map(toPromptResponse);
            });

            if (promptsResult.isErr()) {
                return mapPromptError(status, promptsResult.error);
            }

            return status(200, successResponse(promptsResult.value));
        },
        {
            params: t.Object({
                graphId: t.String(),
            }),
        }
    )
    .post(
        "/graphs/:graphId",
        async ({ body, params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const createResult = await Result.tryPromise(async () => {
                await assertCanManageGraphPrompts(user, params.graphId);
                const prompt = normalizePrompt(body.prompt);

                const [row] = await db.insert(graphPromptsTable).values({ graphId: params.graphId, prompt }).returning({
                    id: graphPromptsTable.id,
                    prompt: graphPromptsTable.prompt,
                    createdAt: graphPromptsTable.createdAt,
                    updatedAt: graphPromptsTable.updatedAt,
                });

                if (!row) {
                    throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
                }

                return toPromptResponse(row);
            });

            if (createResult.isErr()) {
                return mapPromptError(status, createResult.error);
            }

            return status(201, successResponse(createResult.value));
        },
        {
            params: t.Object({
                graphId: t.String(),
            }),
            body: promptBody,
        }
    )
    .patch(
        "/graphs/:graphId/:promptId",
        async ({ body, params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const updateResult = await Result.tryPromise(async () => {
                await assertCanManageGraphPrompts(user, params.graphId);
                const prompt = normalizePrompt(body.prompt);

                const [row] = await db
                    .update(graphPromptsTable)
                    .set({ prompt })
                    .where(
                        and(eq(graphPromptsTable.id, params.promptId), eq(graphPromptsTable.graphId, params.graphId))
                    )
                    .returning({
                        id: graphPromptsTable.id,
                        prompt: graphPromptsTable.prompt,
                        createdAt: graphPromptsTable.createdAt,
                        updatedAt: graphPromptsTable.updatedAt,
                    });

                if (!row) {
                    throw new Error(API_ERROR_CODES.PROMPT_NOT_FOUND);
                }

                return toPromptResponse(row);
            });

            if (updateResult.isErr()) {
                return mapPromptError(status, updateResult.error);
            }

            return status(200, successResponse(updateResult.value));
        },
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
        async ({ params, status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const deleteResult = await Result.tryPromise(async () => {
                await assertCanManageGraphPrompts(user, params.graphId);

                const [row] = await db
                    .delete(graphPromptsTable)
                    .where(
                        and(eq(graphPromptsTable.id, params.promptId), eq(graphPromptsTable.graphId, params.graphId))
                    )
                    .returning({ id: graphPromptsTable.id });

                if (!row) {
                    throw new Error(API_ERROR_CODES.PROMPT_NOT_FOUND);
                }
            });

            if (deleteResult.isErr()) {
                return mapPromptError(status, deleteResult.error);
            }

            return status(204, null);
        },
        {
            params: t.Object({
                graphId: t.String(),
                promptId: t.String(),
            }),
        }
    );
