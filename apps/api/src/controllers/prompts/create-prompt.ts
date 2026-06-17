import { eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { internalServerError, promptLimitExceededError } from "@kiwi/contracts/errors";
import { tryDb } from "@kiwi/db/effect";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { MAX_PROMPTS_PER_SCOPE } from "../../lib/prompt-limits";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, tryApiSync } from "../_shared/api-effect";
import {
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
    return Effect.mapError(
        Effect.gen(function* () {
            const scope = yield* authorizePromptScope(input.user, input.scope);
            const prompt = yield* tryApiSync(() => normalizePrompt(input.prompt));

            switch (scope.kind) {
                case "user": {
                    const row = yield* tryDb((db) =>
                        db.transaction(
                            (tx) =>
                                Effect.gen(function* () {
                                    yield* tx.execute(sql`set transaction isolation level serializable`);
                                    const promptIds = yield* tx
                                        .select({ id: userPromptsTable.id })
                                        .from(userPromptsTable)
                                        .where(eq(userPromptsTable.userId, scope.userId))
                                        .limit(MAX_PROMPTS_PER_SCOPE);
                                    if (promptIds.length >= MAX_PROMPTS_PER_SCOPE) {
                                        return yield* Effect.fail(promptLimitExceededError());
                                    }

                                    const [created] = yield* tx
                                        .insert(userPromptsTable)
                                        .values({ userId: scope.userId, prompt })
                                        .returning(userPromptFields);
                                    return created;
                                })
                        )
                    );

                    if (!row) {
                        return yield* Effect.fail(internalServerError());
                    }

                    return toPromptResponse(row);
                }
                case "team": {
                    const row = yield* tryDb((db) =>
                        db.transaction(
                            (tx) =>
                                Effect.gen(function* () {
                                    yield* tx.execute(sql`set transaction isolation level serializable`);
                                    const promptIds = yield* tx
                                        .select({ id: teamPromptsTable.id })
                                        .from(teamPromptsTable)
                                        .where(eq(teamPromptsTable.teamId, scope.teamId))
                                        .limit(MAX_PROMPTS_PER_SCOPE);
                                    if (promptIds.length >= MAX_PROMPTS_PER_SCOPE) {
                                        return yield* Effect.fail(promptLimitExceededError());
                                    }

                                    const [created] = yield* tx
                                        .insert(teamPromptsTable)
                                        .values({ teamId: scope.teamId, prompt })
                                        .returning(teamPromptFields);
                                    return created;
                                })
                        )
                    );

                    if (!row) {
                        return yield* Effect.fail(internalServerError());
                    }

                    return toPromptResponse(row);
                }
                case "organization": {
                    const row = yield* tryDb((db) =>
                        db.transaction(
                            (tx) =>
                                Effect.gen(function* () {
                                    yield* tx.execute(sql`set transaction isolation level serializable`);
                                    const promptIds = yield* tx
                                        .select({ id: organizationPromptsTable.id })
                                        .from(organizationPromptsTable)
                                        .where(eq(organizationPromptsTable.organizationId, scope.organizationId))
                                        .limit(MAX_PROMPTS_PER_SCOPE);
                                    if (promptIds.length >= MAX_PROMPTS_PER_SCOPE) {
                                        return yield* Effect.fail(promptLimitExceededError());
                                    }

                                    const [created] = yield* tx
                                        .insert(organizationPromptsTable)
                                        .values({ organizationId: scope.organizationId, prompt })
                                        .returning(organizationPromptFields);
                                    return created;
                                })
                        )
                    );

                    if (!row) {
                        return yield* Effect.fail(internalServerError());
                    }

                    return toPromptResponse(row);
                }
                case "graph": {
                    const row = yield* tryDb((db) =>
                        db.transaction(
                            (tx) =>
                                Effect.gen(function* () {
                                    yield* tx.execute(sql`set transaction isolation level serializable`);
                                    const promptIds = yield* tx
                                        .select({ id: graphPromptsTable.id })
                                        .from(graphPromptsTable)
                                        .where(eq(graphPromptsTable.graphId, scope.graphId))
                                        .limit(MAX_PROMPTS_PER_SCOPE);
                                    if (promptIds.length >= MAX_PROMPTS_PER_SCOPE) {
                                        return yield* Effect.fail(promptLimitExceededError());
                                    }

                                    const [created] = yield* tx
                                        .insert(graphPromptsTable)
                                        .values({ graphId: scope.graphId, prompt })
                                        .returning(graphPromptFields);
                                    return created;
                                })
                        )
                    );

                    if (!row) {
                        return yield* Effect.fail(internalServerError());
                    }

                    return toPromptResponse(row);
                }
            }
        }),
        (error) => (isSerializationFailure(error) ? toPromptWriteConflictError() : toApiError(error))
    );
}
