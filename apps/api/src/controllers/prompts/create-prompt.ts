import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { internalServerError } from "@kiwi/contracts/errors";
import { db } from "@kiwi/db";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { MAX_PROMPTS_PER_SCOPE } from "../../lib/prompt-limits";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
import {
    assertPromptCountBelowLimit,
    authorizePromptScope,
    graphPromptFields,
    isSerializationFailure,
    normalizePrompt,
    organizationPromptFields,
    teamPromptFields,
    toPromptResponse,
    type PromptScopeInput,
    toPromptWriteConflictError,
    userPromptFields,
} from "./prompt-scope";

export function createPrompt(input: { user: AuthUser; scope: PromptScopeInput; prompt: string }) {
    return tryApiPromise(async () => {
        const scope = await Effect.runPromise(authorizePromptScope(input.user, input.scope));
        const prompt = normalizePrompt(input.prompt);

        try {
            switch (scope.kind) {
                case "user": {
                    const row = await db.transaction(
                        async (tx) => {
                            await Effect.runPromise(
                                assertPromptCountBelowLimit(() =>
                                    tx
                                        .select({ id: userPromptsTable.id })
                                        .from(userPromptsTable)
                                        .where(eq(userPromptsTable.userId, scope.userId))
                                        .limit(MAX_PROMPTS_PER_SCOPE)
                                )
                            );

                            const [created] = await tx
                                .insert(userPromptsTable)
                                .values({ userId: scope.userId, prompt })
                                .returning(userPromptFields);
                            return created;
                        },
                        { isolationLevel: "serializable" }
                    );

                    if (!row) {
                        throw internalServerError();
                    }

                    return toPromptResponse(row);
                }
                case "team": {
                    const row = await db.transaction(
                        async (tx) => {
                            await Effect.runPromise(
                                assertPromptCountBelowLimit(() =>
                                    tx
                                        .select({ id: teamPromptsTable.id })
                                        .from(teamPromptsTable)
                                        .where(eq(teamPromptsTable.teamId, scope.teamId))
                                        .limit(MAX_PROMPTS_PER_SCOPE)
                                )
                            );

                            const [created] = await tx
                                .insert(teamPromptsTable)
                                .values({ teamId: scope.teamId, prompt })
                                .returning(teamPromptFields);
                            return created;
                        },
                        { isolationLevel: "serializable" }
                    );

                    if (!row) {
                        throw internalServerError();
                    }

                    return toPromptResponse(row);
                }
                case "organization": {
                    const row = await db.transaction(
                        async (tx) => {
                            await Effect.runPromise(
                                assertPromptCountBelowLimit(() =>
                                    tx
                                        .select({ id: organizationPromptsTable.id })
                                        .from(organizationPromptsTable)
                                        .where(eq(organizationPromptsTable.organizationId, scope.organizationId))
                                        .limit(MAX_PROMPTS_PER_SCOPE)
                                )
                            );

                            const [created] = await tx
                                .insert(organizationPromptsTable)
                                .values({ organizationId: scope.organizationId, prompt })
                                .returning(organizationPromptFields);
                            return created;
                        },
                        { isolationLevel: "serializable" }
                    );

                    if (!row) {
                        throw internalServerError();
                    }

                    return toPromptResponse(row);
                }
                case "graph": {
                    const row = await db.transaction(
                        async (tx) => {
                            await Effect.runPromise(
                                assertPromptCountBelowLimit(() =>
                                    tx
                                        .select({ id: graphPromptsTable.id })
                                        .from(graphPromptsTable)
                                        .where(eq(graphPromptsTable.graphId, scope.graphId))
                                        .limit(MAX_PROMPTS_PER_SCOPE)
                                )
                            );

                            const [created] = await tx
                                .insert(graphPromptsTable)
                                .values({ graphId: scope.graphId, prompt })
                                .returning(graphPromptFields);
                            return created;
                        },
                        { isolationLevel: "serializable" }
                    );

                    if (!row) {
                        throw internalServerError();
                    }

                    return toPromptResponse(row);
                }
            }
        } catch (error) {
            if (isSerializationFailure(error)) {
                throw toPromptWriteConflictError();
            }
            throw error;
        }
    });
}
