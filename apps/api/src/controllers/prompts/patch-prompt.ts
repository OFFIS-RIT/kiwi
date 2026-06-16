import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { promptNotFoundError } from "@kiwi/contracts/errors";
import { db } from "@kiwi/db";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
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
    return tryApiPromise(async () => {
        const scope = await Effect.runPromise(authorizePromptScope(input.user, input.scope));
        const prompt = normalizePrompt(input.prompt);

        switch (scope.kind) {
            case "user": {
                const [row] = await db
                    .update(userPromptsTable)
                    .set({ prompt })
                    .where(and(eq(userPromptsTable.id, input.promptId), eq(userPromptsTable.userId, scope.userId)))
                    .returning(userPromptFields);

                if (!row) {
                    throw promptNotFoundError();
                }

                return toPromptResponse(row);
            }
            case "team": {
                const [row] = await db
                    .update(teamPromptsTable)
                    .set({ prompt })
                    .where(and(eq(teamPromptsTable.id, input.promptId), eq(teamPromptsTable.teamId, scope.teamId)))
                    .returning(teamPromptFields);

                if (!row) {
                    throw promptNotFoundError();
                }

                return toPromptResponse(row);
            }
            case "organization": {
                const [row] = await db
                    .update(organizationPromptsTable)
                    .set({ prompt })
                    .where(
                        and(
                            eq(organizationPromptsTable.id, input.promptId),
                            eq(organizationPromptsTable.organizationId, scope.organizationId)
                        )
                    )
                    .returning(organizationPromptFields);

                if (!row) {
                    throw promptNotFoundError();
                }

                return toPromptResponse(row);
            }
            case "graph": {
                const [row] = await db
                    .update(graphPromptsTable)
                    .set({ prompt })
                    .where(and(eq(graphPromptsTable.id, input.promptId), eq(graphPromptsTable.graphId, scope.graphId)))
                    .returning(graphPromptFields);

                if (!row) {
                    throw promptNotFoundError();
                }

                return toPromptResponse(row);
            }
        }
    });
}
