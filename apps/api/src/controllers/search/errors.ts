import * as Effect from "effect/Effect";
import { API_ERROR_CODES, forbiddenError, internalServerError, isApiError } from "@kiwi/contracts/errors";

export function toSearchApiError(error: unknown) {
    if (
        (isApiError(error) && error.code === API_ERROR_CODES.FORBIDDEN) ||
        (error instanceof Error && error.message === API_ERROR_CODES.FORBIDDEN)
    ) {
        return forbiddenError();
    }

    return internalServerError();
}

export function mapSearchFailure<T, E, R>(effect: Effect.Effect<T, E, R>) {
    return Effect.catchDefect(Effect.mapError(effect, toSearchApiError), () => Effect.fail(internalServerError()));
}
