import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { promptNotFoundError } from "@kiwi/contracts/errors";
import { tryDb } from "@kiwi/db/effect";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, tryApiSync } from "../_shared/api-effect";
import {
    authorizePromptScope,
    graphPromptFields,
    normalizePrompt,
    organizationPromptFields,
    teamPromptFields,
    toPromptResponse,
    type PromptScopeInput,
    userPromptFields,
} from "./prompt-scope";

export function patchPrompt(input: { user: AuthUser; scope: PromptScopeInput; promptId: string; prompt: string }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const scope = yield* authorizePromptScope(input.user, input.scope);
            const prompt = yield* tryApiSync(() => normalizePrompt(input.prompt));

            switch (scope.kind) {
                case "user": {
                    const [row] = yield* tryDb((db) =>
                        db
                            .update(userPromptsTable)
                            .set({ prompt })
                            .where(and(eq(userPromptsTable.id, input.promptId), eq(userPromptsTable.userId, scope.userId)))
                            .returning(userPromptFields)
                    );

                    if (!row) {
                        return yield* Effect.fail(promptNotFoundError());
                    }

                    return toPromptResponse(row);
                }
                case "team": {
                    const [row] = yield* tryDb((db) =>
                        db
                            .update(teamPromptsTable)
                            .set({ prompt })
                            .where(and(eq(teamPromptsTable.id, input.promptId), eq(teamPromptsTable.teamId, scope.teamId)))
                            .returning(teamPromptFields)
                    );

                    if (!row) {
                        return yield* Effect.fail(promptNotFoundError());
                    }

                    return toPromptResponse(row);
                }
                case "organization": {
                    const [row] = yield* tryDb((db) =>
                        db
                            .update(organizationPromptsTable)
                            .set({ prompt })
                            .where(
                                and(
                                    eq(organizationPromptsTable.id, input.promptId),
                                    eq(organizationPromptsTable.organizationId, scope.organizationId)
                                )
                            )
                            .returning(organizationPromptFields)
                    );

                    if (!row) {
                        return yield* Effect.fail(promptNotFoundError());
                    }

                    return toPromptResponse(row);
                }
                case "graph": {
                    const [row] = yield* tryDb((db) =>
                        db
                            .update(graphPromptsTable)
                            .set({ prompt })
                            .where(and(eq(graphPromptsTable.id, input.promptId), eq(graphPromptsTable.graphId, scope.graphId)))
                            .returning(graphPromptFields)
                    );

                    if (!row) {
                        return yield* Effect.fail(promptNotFoundError());
                    }

                    return toPromptResponse(row);
                }
            }
        }),
        toApiError
    );
}
