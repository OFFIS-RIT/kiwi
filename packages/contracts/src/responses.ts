export const API_ERROR_CODES = {
    CHAT_NOT_FOUND: "CHAT_NOT_FOUND",
    CHAT_CONTEXT_TOO_LARGE: "CHAT_CONTEXT_TOO_LARGE",
    FORBIDDEN: "FORBIDDEN",
    GRAPH_NOT_FOUND: "GRAPH_NOT_FOUND",
    INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
    INVALID_CHAT_REQUEST: "INVALID_CHAT_REQUEST",
    INVALID_FILE_IDS: "INVALID_FILE_IDS",
    INVALID_GRAPH_OWNER: "INVALID_GRAPH_OWNER",
    INVALID_NAME: "INVALID_NAME",
    INVALID_TEAM_MEMBERS: "INVALID_TEAM_MEMBERS",
    METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
    NO_CHANGES: "NO_CHANGES",
    SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
    TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
    TEXT_UNIT_NOT_FOUND: "TEXT_UNIT_NOT_FOUND",
    UNAUTHORIZED: "UNAUTHORIZED",
    UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
    INVALID_PAGE_RANGE: "INVALID_PAGE_RANGE",
    INVALID_PROMPT: "INVALID_PROMPT",
    PROMPT_LIMIT_EXCEEDED: "PROMPT_LIMIT_EXCEEDED",
    PROMPT_NOT_FOUND: "PROMPT_NOT_FOUND",
    INVALID_SUGGESTION: "INVALID_SUGGESTION",
    SUGGESTION_NOT_FOUND: "SUGGESTION_NOT_FOUND",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

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
