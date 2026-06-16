import Elysia from "elysia";
import { handleConnectorWebhook } from "../controllers/connector/webhooks/handle";
import {
    listActiveConnectorWebhookCandidates,
    normalizeConnectorWebhookPayload,
    parseConnectorWebhookPayload,
    parseConnectorWebhookProvider,
    readConnectorWebhookDeliveryId,
    readConnectorWebhookEventName,
    verifyConnectorWebhookCandidate,
} from "../lib/connector/webhooks";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";
import type { ApiErrorCode } from "../types";

function jsonError(message: string, code: ApiErrorCode, status: number) {
    return new Response(JSON.stringify(errorResponse(message, code)), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function jsonSuccess<TData>(data: TData, status: number) {
    return new Response(JSON.stringify(successResponse(data)), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export const connectorWebhookRoute = new Elysia().post(
    "/connectors/webhooks/:provider",
    async ({ params, request }) => {
        const provider = parseConnectorWebhookProvider(params.provider);
        if (!provider) {
            return jsonError("Unsupported provider", API_ERROR_CODES.INVALID_CHAT_REQUEST, 404);
        }

        const rawBody = await request.text();
        const connector = (await listActiveConnectorWebhookCandidates(provider)).find((candidate) =>
            verifyConnectorWebhookCandidate({
                provider,
                connector: candidate,
                headers: request.headers,
                rawBody,
            })
        );
        if (!connector) {
            return jsonError("Invalid webhook signature", API_ERROR_CODES.FORBIDDEN, 403);
        }

        const payload = parseConnectorWebhookPayload(rawBody);
        if (!payload) {
            return jsonError("Invalid webhook payload", API_ERROR_CODES.INVALID_CHAT_REQUEST, 400);
        }

        const eventName = readConnectorWebhookEventName(provider, request.headers, payload);
        const deliveryId = readConnectorWebhookDeliveryId(provider, request.headers, payload);
        const event = normalizeConnectorWebhookPayload({ provider, eventName, deliveryId, payload });
        return jsonSuccess(await handleConnectorWebhook({ connector, event }), 202);
    }
);
