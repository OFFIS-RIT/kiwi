import * as Effect from "effect/Effect";
import { errorResponse, successResponse, type ApiError } from "@kiwi/contracts/errors";
import { DatabaseLayer, type Database } from "@kiwi/db/effect";
import { toApiError } from "../../_shared/api-effect";
import { handleConnectorWebhook, type HandleConnectorWebhookResult } from "./handle";
import { resolveConnectorWebhookRequest, type ConnectorWebhookRequestInput } from "./request";

export function receiveConnectorWebhook(
    input: ConnectorWebhookRequestInput
): Effect.Effect<HandleConnectorWebhookResult, ApiError, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            const { connector, event } = yield* resolveConnectorWebhookRequest(input);
            return yield* handleConnectorWebhook({ connector, event });
        }),
        toApiError
    );
}

export function handleConnectorWebhookRequest(input: { provider: string; request: Request }) {
    return Effect.runPromise(
        Effect.provide(
            Effect.match(
                Effect.gen(function* () {
                    const rawBody = yield* Effect.tryPromise({
                        try: () => input.request.text(),
                        catch: toApiError,
                    });

                    return yield* receiveConnectorWebhook({
                        provider: input.provider,
                        headers: input.request.headers,
                        rawBody,
                    });
                }),
                {
                    onFailure: (apiError) =>
                        new Response(JSON.stringify(errorResponse(apiError.responseMessage, apiError.code)), {
                            status: apiError.status,
                            headers: { "Content-Type": "application/json" },
                        }),
                    onSuccess: (value) =>
                        new Response(JSON.stringify(successResponse(value)), {
                            status: 202,
                            headers: { "Content-Type": "application/json" },
                        }),
                }
            ),
            DatabaseLayer
        )
    );
}
