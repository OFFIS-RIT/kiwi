import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { promptNotFoundError } from "@kiwi/contracts/errors";
import { db } from "@kiwi/db";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
import { authorizePromptScope, type PromptScopeInput } from "./prompt-scope";

export function deletePrompt(input: { user: AuthUser; scope: PromptScopeInput; promptId: string }) {
    return tryApiPromise(async () => {
        const scope = await Effect.runPromise(authorizePromptScope(input.user, input.scope));

        switch (scope.kind) {
            case "user": {
                const [row] = await db
                    .delete(userPromptsTable)
                    .where(and(eq(userPromptsTable.id, input.promptId), eq(userPromptsTable.userId, scope.userId)))
                    .returning({ id: userPromptsTable.id });

                if (!row) {
                    throw promptNotFoundError();
                }

                return null;
            }
            case "team": {
                const [row] = await db
                    .delete(teamPromptsTable)
                    .where(and(eq(teamPromptsTable.id, input.promptId), eq(teamPromptsTable.teamId, scope.teamId)))
                    .returning({ id: teamPromptsTable.id });

                if (!row) {
                    throw promptNotFoundError();
                }

                return null;
            }
            case "organization": {
                const [row] = await db
                    .delete(organizationPromptsTable)
                    .where(
                        and(
                            eq(organizationPromptsTable.id, input.promptId),
                            eq(organizationPromptsTable.organizationId, scope.organizationId)
                        )
                    )
                    .returning({ id: organizationPromptsTable.id });

                if (!row) {
                    throw promptNotFoundError();
                }

                return null;
            }
            case "graph": {
                const [row] = await db
                    .delete(graphPromptsTable)
                    .where(and(eq(graphPromptsTable.id, input.promptId), eq(graphPromptsTable.graphId, scope.graphId)))
                    .returning({ id: graphPromptsTable.id });

                if (!row) {
                    throw promptNotFoundError();
                }

                return null;
            }
        }
    });
}
