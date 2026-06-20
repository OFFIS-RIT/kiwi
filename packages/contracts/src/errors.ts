import { Schema } from "effect";

export const API_ERROR_CODES = {
    CHAT_NOT_FOUND: "CHAT_NOT_FOUND",
    CHAT_CONTEXT_TOO_LARGE: "CHAT_CONTEXT_TOO_LARGE",
    FORBIDDEN: "FORBIDDEN",
    GRAPH_NOT_FOUND: "GRAPH_NOT_FOUND",
    INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
    INVALID_CHAT_REQUEST: "INVALID_CHAT_REQUEST",
    INVALID_FILE_IDS: "INVALID_FILE_IDS",
    INVALID_GRAPH_OWNER: "INVALID_GRAPH_OWNER",
    INVALID_MODEL: "INVALID_MODEL",
    INVALID_NAME: "INVALID_NAME",
    INVALID_TEAM_MEMBERS: "INVALID_TEAM_MEMBERS",
    METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
    MODEL_NOT_CONFIGURED: "MODEL_NOT_CONFIGURED",
    MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
    NO_CHANGES: "NO_CHANGES",
    ORGANIZATION_NOT_FOUND: "ORGANIZATION_NOT_FOUND",
    SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
    TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
    TEXT_UNIT_NOT_FOUND: "TEXT_UNIT_NOT_FOUND",
    UNAUTHORIZED: "UNAUTHORIZED",
    UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
    UPLOAD_LIMIT_EXCEEDED: "UPLOAD_LIMIT_EXCEEDED",
    INVALID_PAGE_RANGE: "INVALID_PAGE_RANGE",
    INVALID_PROMPT: "INVALID_PROMPT",
    PROMPT_LIMIT_EXCEEDED: "PROMPT_LIMIT_EXCEEDED",
    PROMPT_NOT_FOUND: "PROMPT_NOT_FOUND",
    INVALID_SUGGESTION: "INVALID_SUGGESTION",
    SUGGESTION_NOT_FOUND: "SUGGESTION_NOT_FOUND",
    FILE_TYPE_NOT_FOUND: "FILE_TYPE_NOT_FOUND",
    INVALID_FILE_TYPE_CONFIG: "INVALID_FILE_TYPE_CONFIG",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
export const API_ERROR_CODE_VALUES = Object.values(API_ERROR_CODES) as [ApiErrorCode, ...ApiErrorCode[]];
export const ApiErrorCodeSchema = Schema.Literals(API_ERROR_CODE_VALUES);

export class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
    status: Schema.Int,
    code: ApiErrorCodeSchema,
    responseMessage: Schema.String,
}) {
    override get message(): string {
        return this.code;
    }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

export const makeApiError = <TCode extends ApiErrorCode>(status: number, code: TCode, responseMessage: string) =>
    new ApiError({ status, code, responseMessage });

export const unauthorizedError = () => makeApiError(401, API_ERROR_CODES.UNAUTHORIZED, "Unauthorized");
export const forbiddenError = () => makeApiError(403, API_ERROR_CODES.FORBIDDEN, "Forbidden");
export const teamNotFoundError = () => makeApiError(404, API_ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
export const organizationNotFoundError = () =>
    makeApiError(404, API_ERROR_CODES.ORGANIZATION_NOT_FOUND, "Organization not found");
export const graphNotFoundError = () => makeApiError(404, API_ERROR_CODES.GRAPH_NOT_FOUND, "Graph not found");
export const modelNotFoundError = () => makeApiError(404, API_ERROR_CODES.MODEL_NOT_FOUND, "Model not found");
export const promptNotFoundError = () => makeApiError(404, API_ERROR_CODES.PROMPT_NOT_FOUND, "Prompt not found");
export const sourceNotFoundError = () => makeApiError(404, API_ERROR_CODES.SOURCE_NOT_FOUND, "Source not found");
export const textUnitNotFoundError = () =>
    makeApiError(404, API_ERROR_CODES.TEXT_UNIT_NOT_FOUND, "Text unit not found");
export const invalidTeamMembersError = () =>
    makeApiError(400, API_ERROR_CODES.INVALID_TEAM_MEMBERS, "A team must have at least one admin");
export const invalidModelError = () => makeApiError(400, API_ERROR_CODES.INVALID_MODEL, "Invalid model");
export const invalidPromptError = () => makeApiError(400, API_ERROR_CODES.INVALID_PROMPT, "Invalid prompt");
export const promptLimitExceededError = () =>
    makeApiError(400, API_ERROR_CODES.PROMPT_LIMIT_EXCEEDED, "Prompt limit exceeded");
export const invalidGraphOwnerError = () =>
    makeApiError(400, API_ERROR_CODES.INVALID_GRAPH_OWNER, "Invalid graph owner chain");
export const invalidFileIdsError = () => makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "Invalid file IDs");
export const noChangesError = () => makeApiError(400, API_ERROR_CODES.NO_CHANGES, "No changes requested");
export const modelNotConfiguredError = () =>
    makeApiError(
        400,
        API_ERROR_CODES.MODEL_NOT_CONFIGURED,
        "Define a model for this organization before using AI features"
    );
export const internalServerError = (message = "Internal server error") =>
    makeApiError(500, API_ERROR_CODES.INTERNAL_SERVER_ERROR, message);
export const retryableInternalError = (message: string) =>
    makeApiError(503, API_ERROR_CODES.INTERNAL_SERVER_ERROR, message);

export type BaseResponse = {
    status: "success" | "error";
};

export type SuccessfulResponse<TData> = BaseResponse & {
    status: "success";
    data: TData;
};

export type ErrorResponse<TCode extends ApiErrorCode = ApiErrorCode> = BaseResponse & {
    status: "error";
    message: string;
    code: TCode;
};

export type ApiResponse<TData, TCode extends ApiErrorCode = ApiErrorCode> =
    | SuccessfulResponse<TData>
    | ErrorResponse<TCode>;

export const successResponse = <TData>(data: TData): SuccessfulResponse<TData> => ({
    status: "success",
    data,
});

export const errorResponse = <TCode extends ApiErrorCode>(message: string, code: TCode): ErrorResponse<TCode> => ({
    status: "error",
    message,
    code,
});
