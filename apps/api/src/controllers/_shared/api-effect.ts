import * as Effect from "effect/Effect";
import { DatabaseLayer, type Database } from "@kiwi/db/effect";
import {
    API_ERROR_CODES,
    type ApiErrorCode,
    ApiError,
    errorResponse,
    internalServerError,
    isApiError,
    makeApiError,
    unauthorizedError,
} from "@kiwi/contracts/errors";
import type { AuthUser } from "../../middleware/auth";

export type RouteStatus = (code: number, body: unknown) => unknown;

export type UnknownApiErrorMapper = (error: Error) => ApiError;
export type ApiErrorMapping = { status: number; responseMessage: string };

export type ApiErrorOptions = {
    legacyErrors?: Partial<Record<ApiErrorCode, ApiErrorMapping>>;
    mapUnknownError?: UnknownApiErrorMapper;
};

const LEGACY_API_ERRORS: Partial<Record<ApiErrorCode, ApiErrorMapping>> = {
    [API_ERROR_CODES.UNAUTHORIZED]: { status: 401, responseMessage: "Unauthorized" },
    [API_ERROR_CODES.FORBIDDEN]: { status: 403, responseMessage: "Forbidden" },
    [API_ERROR_CODES.TEAM_NOT_FOUND]: { status: 404, responseMessage: "Team not found" },
    [API_ERROR_CODES.ORGANIZATION_NOT_FOUND]: { status: 404, responseMessage: "Organization not found" },
    [API_ERROR_CODES.GRAPH_NOT_FOUND]: { status: 404, responseMessage: "Graph not found" },
    [API_ERROR_CODES.MODEL_NOT_FOUND]: { status: 404, responseMessage: "Model not found" },
    [API_ERROR_CODES.PROMPT_NOT_FOUND]: { status: 404, responseMessage: "Prompt not found" },
    [API_ERROR_CODES.SOURCE_NOT_FOUND]: { status: 404, responseMessage: "Source not found" },
    [API_ERROR_CODES.TEXT_UNIT_NOT_FOUND]: { status: 404, responseMessage: "Text unit not found" },
    [API_ERROR_CODES.INVALID_TEAM_MEMBERS]: {
        status: 400,
        responseMessage: "A team must have at least one admin",
    },
    [API_ERROR_CODES.INVALID_MODEL]: { status: 400, responseMessage: "Invalid model" },
    [API_ERROR_CODES.INVALID_PROMPT]: { status: 400, responseMessage: "Invalid prompt" },
    [API_ERROR_CODES.PROMPT_LIMIT_EXCEEDED]: { status: 400, responseMessage: "Prompt limit exceeded" },
    [API_ERROR_CODES.INVALID_GRAPH_OWNER]: { status: 400, responseMessage: "Invalid graph owner chain" },
    [API_ERROR_CODES.INVALID_FILE_IDS]: { status: 400, responseMessage: "Invalid file IDs" },
    [API_ERROR_CODES.NO_CHANGES]: { status: 400, responseMessage: "No changes requested" },
    [API_ERROR_CODES.MODEL_NOT_CONFIGURED]: {
        status: 400,
        responseMessage: "Define a model for this organization before using AI features",
    },
    [API_ERROR_CODES.INTERNAL_SERVER_ERROR]: { status: 500, responseMessage: "Internal server error" },
};

export const connectorInvalidRequestError: UnknownApiErrorMapper = (error) =>
    makeApiError(
        400,
        API_ERROR_CODES.INVALID_CHAT_REQUEST,
        error.message.replace(/^Unhandled exception:\s*/u, "") || "Invalid connector request"
    );

export const connectorApiErrorOptions = {
    legacyErrors: {
        [API_ERROR_CODES.GRAPH_NOT_FOUND]: { status: 404, responseMessage: "Not found" },
    },
    mapUnknownError: connectorInvalidRequestError,
} satisfies ApiErrorOptions;

export function toApiError(error: unknown, options: ApiErrorOptions = {}): ApiError {
    if (isApiError(error)) {
        return error;
    }

    if (error instanceof Error) {
        const normalizedCode = error.message.replace(/^Unhandled exception:\s*/u, "") as ApiErrorCode;
        const legacyApiError = options.legacyErrors?.[normalizedCode] ?? LEGACY_API_ERRORS[normalizedCode];

        if (legacyApiError) {
            return makeApiError(legacyApiError.status, normalizedCode, legacyApiError.responseMessage);
        }

        if (error.cause !== undefined) {
            return toApiError(error.cause, options);
        }

        if (options.mapUnknownError) {
            return options.mapUnknownError(error);
        }
    }

    return internalServerError();
}

export function mapApiError(status: RouteStatus, error: unknown, options: ApiErrorOptions = {}) {
    const apiError = toApiError(error, options);
    return status(apiError.status, errorResponse(apiError.responseMessage, apiError.code));
}

export type ApiEffect<T, E = never, R = never> = Effect.Effect<T, ApiError | E, R>;

export function tryApiSync<T>(thunk: () => T, options: ApiErrorOptions = {}): ApiEffect<T> {
    return Effect.try({
        try: thunk,
        catch: (error) => toApiError(error, options),
    });
}

export function runApiAction<T, E>(
    options: ApiErrorOptions & {
        status: RouteStatus;
        user: AuthUser | null | undefined;
        action: (user: AuthUser) => Effect.Effect<T, E, Database>;
        success: (value: T) => unknown;
        databaseLayer?: typeof DatabaseLayer;
    }
) {
    if (!options.user) {
        const apiError = unauthorizedError();
        return Promise.resolve(options.status(apiError.status, errorResponse(apiError.responseMessage, apiError.code)));
    }

    const action = Effect.match(options.action(options.user), {
        onFailure: (error) => mapApiError(options.status, error, options),
        onSuccess: options.success,
    });

    return Effect.runPromise(Effect.provide(action, options.databaseLayer ?? DatabaseLayer));
}
