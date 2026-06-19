import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { toApiError, type ApiErrorOptions } from "../../_shared/api-effect";

const graphSuggestionApiErrorOptions = {
    legacyErrors: {
        [API_ERROR_CODES.SUGGESTION_NOT_FOUND]: { status: 404, responseMessage: "Suggestion not found" },
        [API_ERROR_CODES.INVALID_SUGGESTION]: { status: 400, responseMessage: "Invalid suggestion" },
    },
} satisfies ApiErrorOptions;

export const toGraphSuggestionApiError = (error: unknown) => toApiError(error, graphSuggestionApiErrorOptions);
