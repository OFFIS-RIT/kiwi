import { auth } from "@kiwi/auth/server";
import * as Effect from "effect/Effect";
import { API_ERROR_CODES, errorResponse } from "../../types";
import type { RouteStatus } from "../_shared/api-effect";

type BetterAuthRequestOptions = {
    request: Request;
    status: RouteStatus;
};

export function handleBetterAuthRequest({ request, status }: BetterAuthRequestOptions) {
    return Effect.runPromise(
        Effect.gen(function* () {
            if (request.method === "GET" || request.method === "POST") {
                return yield* Effect.tryPromise({
                    try: () => auth.handler(request),
                    catch: (error) => error,
                });
            }

            return status(405, errorResponse("Method not allowed", API_ERROR_CODES.METHOD_NOT_ALLOWED));
        })
    );
}
