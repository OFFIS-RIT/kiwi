import { Schema } from "effect";
import type { ApiResponse } from "./errors";
import type { MutableSchemaType } from "./schema";

export type PromptRecord = {
    id: string;
    prompt: string;
    created_at: string;
    updated_at: string;
};

export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_PROMPTS_PER_SCOPE = 5;

export const PromptTextSchema = Schema.Trim.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PROMPT_LENGTH))
);
export const PromptBodySchema = Schema.Struct({
    prompt: Schema.String,
});
export const NormalizedPromptBodySchema = Schema.Struct({
    prompt: PromptTextSchema,
});
export type PromptBody = MutableSchemaType<Schema.Schema.Type<typeof PromptBodySchema>>;

export type UserPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;

export type UserPromptCreateResponse = ApiResponse<
    PromptRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_PROMPT" | "PROMPT_LIMIT_EXCEEDED" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptCreateResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "TEAM_NOT_FOUND"
    | "INVALID_PROMPT"
    | "PROMPT_LIMIT_EXCEEDED"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptCreateResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_PROMPT"
    | "PROMPT_LIMIT_EXCEEDED"
    | "INTERNAL_SERVER_ERROR"
>;

export type UserPromptPatchResponse = ApiResponse<
    PromptRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "PROMPT_NOT_FOUND" | "INVALID_PROMPT" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptPatchResponse = ApiResponse<
    PromptRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "PROMPT_NOT_FOUND" | "INVALID_PROMPT" | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptPatchResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "PROMPT_NOT_FOUND"
    | "INVALID_PROMPT"
    | "INTERNAL_SERVER_ERROR"
>;

export type UserPromptDeleteResponse = ApiResponse<
    null,
    "UNAUTHORIZED" | "FORBIDDEN" | "PROMPT_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptDeleteResponse = ApiResponse<
    null,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "PROMPT_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptDeleteResponse = ApiResponse<
    null,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "PROMPT_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "ORGANIZATION_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptCreateResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "ORGANIZATION_NOT_FOUND"
    | "INVALID_PROMPT"
    | "PROMPT_LIMIT_EXCEEDED"
    | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptPatchResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "ORGANIZATION_NOT_FOUND"
    | "PROMPT_NOT_FOUND"
    | "INVALID_PROMPT"
    | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptDeleteResponse = ApiResponse<
    null,
    "UNAUTHORIZED" | "FORBIDDEN" | "ORGANIZATION_NOT_FOUND" | "PROMPT_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;
