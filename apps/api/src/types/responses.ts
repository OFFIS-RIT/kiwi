export const API_ERROR_CODES = {
    FORBIDDEN: "FORBIDDEN",
    GRAPH_NOT_FOUND: "GRAPH_NOT_FOUND",
    GROUP_NOT_FOUND: "GROUP_NOT_FOUND",
    INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
    INVALID_FILE_IDS: "INVALID_FILE_IDS",
    INVALID_GRAPH_OWNER: "INVALID_GRAPH_OWNER",
    INVALID_NAME: "INVALID_NAME",
    METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
    NO_CHANGES: "NO_CHANGES",
    TEXT_UNIT_NOT_FOUND: "TEXT_UNIT_NOT_FOUND",
    UNAUTHORIZED: "UNAUTHORIZED",
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
