import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { asc, eq } from "@kiwi/db/drizzle";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";
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
    return Effect.mapError(
        Effect.gen(function* () {
            const scope = yield* authorizePromptScope(input.user, input.scope);

            switch (scope.kind) {
                case "user": {
                    const rows = yield* tryDb((db) =>
                        db
                            .select(userPromptFields)
                            .from(userPromptsTable)
                            .where(eq(userPromptsTable.userId, scope.userId))
                            .orderBy(asc(userPromptsTable.createdAt), asc(userPromptsTable.id))
                    );
                    return rows.map(toPromptResponse);
                }
                case "team": {
                    const rows = yield* tryDb((db) =>
                        db
                            .select(teamPromptFields)
                            .from(teamPromptsTable)
                            .where(eq(teamPromptsTable.teamId, scope.teamId))
                            .orderBy(asc(teamPromptsTable.createdAt), asc(teamPromptsTable.id))
                    );
                    return rows.map(toPromptResponse);
                }
                case "organization": {
                    const rows = yield* tryDb((db) =>
                        db
                            .select(organizationPromptFields)
                            .from(organizationPromptsTable)
                            .where(eq(organizationPromptsTable.organizationId, scope.organizationId))
                            .orderBy(asc(organizationPromptsTable.createdAt), asc(organizationPromptsTable.id))
                    );
                    return rows.map(toPromptResponse);
                }
                case "graph": {
                    const rows = yield* tryDb((db) =>
                        db
                            .select(graphPromptFields)
                            .from(graphPromptsTable)
                            .where(eq(graphPromptsTable.graphId, scope.graphId))
                            .orderBy(asc(graphPromptsTable.createdAt), asc(graphPromptsTable.id))
                    );
                    return rows.map(toPromptResponse);
                }
            }
        }),
        toApiError
    );
}
