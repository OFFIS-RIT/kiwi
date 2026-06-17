import * as Effect from "effect/Effect";
import { type PromptRecord, NormalizedPromptBodySchema } from "@kiwi/contracts/prompts";
import { invalidPromptError, retryableInternalError } from "@kiwi/contracts/errors";
import { decodeApiSchemaSync } from "@kiwi/contracts/schema";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import type { Database } from "@kiwi/db/effect";
import {
    assertCanManageGraphPrompts,
    assertCanManageOrganizationPrompts,
    assertCanManageTeamPrompts,
    assertCanManageUserPrompts,
} from "../../lib/prompt-access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, type ApiEffect } from "../_shared/api-effect";

const decodePromptBody = decodeApiSchemaSync(NormalizedPromptBodySchema);

export type PromptScopeInput =
    | { kind: "user"; userId: string }
    | { kind: "team"; teamId: string }
    | { kind: "organization"; organizationId: string }
    | { kind: "graph"; graphId: string };

export type PromptRow = {
    id: string;
    prompt: string;
    createdAt: Date;
    updatedAt: Date;
};

export const userPromptFields = {
    id: userPromptsTable.id,
    prompt: userPromptsTable.prompt,
    createdAt: userPromptsTable.createdAt,
    updatedAt: userPromptsTable.updatedAt,
};

export const teamPromptFields = {
    id: teamPromptsTable.id,
    prompt: teamPromptsTable.prompt,
    createdAt: teamPromptsTable.createdAt,
    updatedAt: teamPromptsTable.updatedAt,
};

export const organizationPromptFields = {
    id: organizationPromptsTable.id,
    prompt: organizationPromptsTable.prompt,
    createdAt: organizationPromptsTable.createdAt,
    updatedAt: organizationPromptsTable.updatedAt,
};

export const graphPromptFields = {
    id: graphPromptsTable.id,
    prompt: graphPromptsTable.prompt,
    createdAt: graphPromptsTable.createdAt,
    updatedAt: graphPromptsTable.updatedAt,
};

export function authorizePromptScope(user: AuthUser, scope: PromptScopeInput): ApiEffect<PromptScopeInput, never, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            switch (scope.kind) {
                case "user": {
                    const userId = scope.userId === "me" ? user.id : scope.userId;
                    yield* assertCanManageUserPrompts(user, userId);
                    return { kind: "user" as const, userId };
                }
                case "team":
                    yield* assertCanManageTeamPrompts(user, scope.teamId);
                    return scope;
                case "organization":
                    yield* assertCanManageOrganizationPrompts(user, scope.organizationId);
                    return scope;
                case "graph":
                    yield* assertCanManageGraphPrompts(user, scope.graphId);
                    return scope;
            }
        }),
        toApiError
    );
}

export function normalizePrompt(rawPrompt: string): string {
    try {
        return decodePromptBody({ prompt: rawPrompt }).prompt;
    } catch {
        throw invalidPromptError();
    }
}


export function toPromptResponse(row: PromptRow): PromptRecord {
    return {
        id: row.id,
        prompt: row.prompt,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
    };
}

export function isSerializationFailure(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }

    if ("code" in error && error.code === "40001") {
        return true;
    }

    return "cause" in error && isSerializationFailure(error.cause);
}

export function toPromptWriteConflictError() {
    return retryableInternalError("Prompt write conflict; retry the request");
}
