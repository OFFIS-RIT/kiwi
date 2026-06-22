import * as Effect from "effect/Effect";
import { API_ERROR_CODES, type ApiError, makeApiError } from "@kiwi/contracts/errors";
import { normalizeConnectorWebhook, verifyConnectorWebhook, type ConnectorResourceKind } from "@kiwi/connectors";
import { tryDb, type Database, type DatabaseError } from "@kiwi/db/effect";
import { connectorsTable, type ConnectorProvider } from "@kiwi/db/tables/connectors";
import { and, eq } from "@kiwi/db/drizzle";
import { decryptSecret } from "../../../lib/connectors";

const CONNECTOR_PROVIDERS: Record<ConnectorProvider, true> = { github: true, gitlab: true };

const ZERO_SHA = /^0+$/;

const UNSUPPORTED_PROVIDER_ERROR = makeApiError(404, API_ERROR_CODES.INVALID_CHAT_REQUEST, "Unsupported provider");
const INVALID_SIGNATURE_ERROR = makeApiError(403, API_ERROR_CODES.FORBIDDEN, "Invalid webhook signature");
const INVALID_PAYLOAD_ERROR = makeApiError(400, API_ERROR_CODES.INVALID_CHAT_REQUEST, "Invalid webhook payload");

export type ConnectorWebhookCandidate = typeof connectorsTable.$inferSelect;

export type NormalizedConnectorWebhook = {
    provider: ConnectorProvider;
    deliveryId: string;
    eventName: string;
    eventType: "push" | "other";
    resourceKind: ConnectorResourceKind;
    resourceId: string | null;
    resourceName: string | null;
    versionName: string | null;
    versionId: string | null;
    cursor: string | null;
    deleted: boolean;
    rawPayload: unknown;
};

export type ConnectorWebhookRequestInput = {
    provider: string;
    headers: Headers;
    rawBody: string;
};

export type ResolvedConnectorWebhookRequest = {
    connector: ConnectorWebhookCandidate;
    event: NormalizedConnectorWebhook;
};

function parseConnectorWebhookPayload(rawBody: string): Effect.Effect<Record<string, unknown>, ApiError> {
    try {
        const payload = JSON.parse(rawBody);
        return payload && typeof payload === "object" && !Array.isArray(payload)
            ? Effect.succeed(payload as Record<string, unknown>)
            : Effect.fail(INVALID_PAYLOAD_ERROR);
    } catch {
        return Effect.fail(INVALID_PAYLOAD_ERROR);
    }
}

function normalizeConnectorWebhookPayload(options: {
    provider: ConnectorProvider;
    eventName: string;
    deliveryId: string;
    payload: Record<string, unknown>;
}): NormalizedConnectorWebhook {
    const normalized = normalizeConnectorWebhook(options.provider, {
        eventName: options.eventName,
        deliveryId: options.deliveryId,
        payload: options.payload,
    });
    const eventType =
        normalized.provider === "github"
            ? normalized.eventName === "push"
                ? "push"
                : "other"
            : normalized.eventName === "Push Hook" || normalized.eventName === "push"
              ? "push"
              : "other";

    const cursor = "cursor" in normalized && typeof normalized.cursor === "string" ? normalized.cursor : null;

    return {
        provider: normalized.provider,
        deliveryId: normalized.deliveryId,
        eventName: normalized.eventName,
        eventType,
        resourceKind: normalized.resourceKind,
        resourceId: normalized.resourceId,
        resourceName: normalized.resourceName,
        versionName: normalized.versionName,
        versionId: normalized.versionId,
        cursor,
        deleted: !normalized.versionId || ZERO_SHA.test(normalized.versionId),
        rawPayload: normalized.raw,
    };
}

export function resolveConnectorWebhookRequest(
    input: ConnectorWebhookRequestInput
): Effect.Effect<ResolvedConnectorWebhookRequest, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        const provider = Object.hasOwn(CONNECTOR_PROVIDERS, input.provider)
            ? (input.provider as ConnectorProvider)
            : yield* Effect.fail(UNSUPPORTED_PROVIDER_ERROR);
        const candidates = yield* tryDb((db) =>
            db
                .select()
                .from(connectorsTable)
                .where(and(eq(connectorsTable.provider, provider), eq(connectorsTable.status, "active")))
        );
        const connector = candidates.find((candidate) =>
            verifyConnectorWebhook(provider, {
                body: input.rawBody,
                headers: input.headers,
                webhookSecret: decryptSecret(candidate.webhookSecretEncrypted),
            })
        );

        if (!connector) {
            return yield* Effect.fail(INVALID_SIGNATURE_ERROR);
        }

        const payload = yield* parseConnectorWebhookPayload(input.rawBody);
        const eventName =
            provider === "github"
                ? input.headers.get("x-github-event") || "unknown"
                : input.headers.get("x-gitlab-event") || String(payload.event_name ?? "unknown");
        const deliveryId =
            provider === "github"
                ? input.headers.get("x-github-delivery") || "missing"
                : input.headers.get("x-gitlab-webhook-uuid") ||
                  `${String(payload.event_name ?? "event")}:${String(payload.after ?? Date.now())}`;

        return {
            connector,
            event: normalizeConnectorWebhookPayload({ provider, eventName, deliveryId, payload }),
        };
    });
}
