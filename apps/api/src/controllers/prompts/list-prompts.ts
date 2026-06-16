import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { asc, eq } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
import {
    authorizePromptScope,
    graphPromptFields,
    organizationPromptFields,
    teamPromptFields,
    toPromptResponse,
    type PromptScopeInput,
    userPromptFields,
} from "./prompt-scope";

export function listPrompts(input: { user: AuthUser; scope: PromptScopeInput }) {
    return tryApiPromise(async () => {
        const scope = await Effect.runPromise(authorizePromptScope(input.user, input.scope));

        switch (scope.kind) {
            case "user": {
                const rows = await db
                    .select(userPromptFields)
                    .from(userPromptsTable)
                    .where(eq(userPromptsTable.userId, scope.userId))
                    .orderBy(asc(userPromptsTable.createdAt), asc(userPromptsTable.id));
                return rows.map(toPromptResponse);
            }
            case "team": {
                const rows = await db
                    .select(teamPromptFields)
                    .from(teamPromptsTable)
                    .where(eq(teamPromptsTable.teamId, scope.teamId))
                    .orderBy(asc(teamPromptsTable.createdAt), asc(teamPromptsTable.id));
                return rows.map(toPromptResponse);
            }
            case "organization": {
                const rows = await db
                    .select(organizationPromptFields)
                    .from(organizationPromptsTable)
                    .where(eq(organizationPromptsTable.organizationId, scope.organizationId))
                    .orderBy(asc(organizationPromptsTable.createdAt), asc(organizationPromptsTable.id));
                return rows.map(toPromptResponse);
            }
            case "graph": {
                const rows = await db
                    .select(graphPromptFields)
                    .from(graphPromptsTable)
                    .where(eq(graphPromptsTable.graphId, scope.graphId))
                    .orderBy(asc(graphPromptsTable.createdAt), asc(graphPromptsTable.id));
                return rows.map(toPromptResponse);
            }
        }
    });
}
