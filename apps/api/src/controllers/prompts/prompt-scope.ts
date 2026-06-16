import { type PromptRecord, NormalizedPromptBodySchema } from "@kiwi/contracts/prompts";
import { invalidPromptError, promptLimitExceededError, retryableInternalError } from "@kiwi/contracts/errors";
import { decodeApiSchemaSync } from "@kiwi/contracts/schema";
import { graphPromptsTable } from "@kiwi/db/tables/graph";
import { organizationPromptsTable, teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { assertCanManageGraphPrompts, assertCanManageOrganizationPrompts, assertCanManageTeamPrompts, assertCanManageUserPrompts } from "../../lib/prompt-access";
import { MAX_PROMPTS_PER_SCOPE } from "../../lib/prompt-limits";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise, type ApiEffect } from "../_shared/api-effect";

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

export function authorizePromptScope(user: AuthUser, scope: PromptScopeInput): ApiEffect<PromptScopeInput> {
    return tryApiPromise(async () => {
        switch (scope.kind) {
            case "user": {
                const userId = scope.userId === "me" ? user.id : scope.userId;
                await assertCanManageUserPrompts(user, userId);
                return { kind: "user", userId };
            }
            case "team":
                await assertCanManageTeamPrompts(user, scope.teamId);
                return scope;
            case "organization":
                await assertCanManageOrganizationPrompts(user, scope.organizationId);
                return scope;
            case "graph":
                await assertCanManageGraphPrompts(user, scope.graphId);
                return scope;
        }
    });
}

export function normalizePrompt(rawPrompt: string): string {
    try {
        return decodePromptBody({ prompt: rawPrompt }).prompt;
    } catch {
        throw invalidPromptError();
    }
}

export function assertPromptCountBelowLimit(loadPromptIds: () => Promise<unknown[]>) {
    return tryApiPromise(async () => {
        const promptIds = await loadPromptIds();
        if (promptIds.length >= MAX_PROMPTS_PER_SCOPE) {
            throw promptLimitExceededError();
        }
    });
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
