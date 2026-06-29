import * as Effect from "effect/Effect";
import { API_ERROR_CODES, type ApiError, makeApiError } from "@kiwi/contracts/errors";
import {
    isKnownConnectorProvider,
    normalizeConnectorWebhook,
    verifyConnectorWebhook,
    type ConnectorResourceKind,
} from "@kiwi/connectors";
import { tryDb, type Database, type DatabaseError } from "@kiwi/db/effect";
import { connectorsTable, type ConnectorProvider } from "@kiwi/db/tables/connectors";
import { and, eq, or } from "@kiwi/db/drizzle";
import { decryptSecret } from "../../../lib/connectors";

const ZERO_SHA = /^0+$/;

const UNSUPPORTED_PROVIDER_ERROR = makeApiError(404, API_ERROR_CODES.INVALID_CHAT_REQUEST, "Unsupported provider");
const INVALID_SIGNATURE_ERROR = makeApiError(403, API_ERROR_CODES.FORBIDDEN, "Invalid webhook signature");
const INVALID_PAYLOAD_ERROR = makeApiError(400, API_ERROR_CODES.INVALID_CHAT_REQUEST, "Invalid webhook payload");

export type ConnectorWebhookCandidate = typeof connectorsTable.$inferSelect;

type NormalizedConnectorWebhookBase = {
    provider: ConnectorProvider;
    deliveryId: string;
    eventName: string;
    resourceKind: ConnectorResourceKind;
    resourceId: string | null;
    resourceName: string | null;
    versionName: string | null;
    versionId: string | null;
    cursor: string | null;
    rawPayload: unknown;
};

export type NormalizedConnectorWebhook =
    | (NormalizedConnectorWebhookBase & { type: "resource.versionChanged"; versionName: string; versionId: string })
    | (NormalizedConnectorWebhookBase & { type: "resource.cursorAdvanced"; cursor: string })
    | (NormalizedConnectorWebhookBase & { type: "resource.deleted" })
    | (NormalizedConnectorWebhookBase & { type: "installation.changed" });

export type ConnectorWebhookRequestInput = {
    provider: string;
    connectorIdOrSlug?: string;
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
    const cursor = "cursor" in normalized && typeof normalized.cursor === "string" ? normalized.cursor : null;
    const common: NormalizedConnectorWebhookBase = {
        provider: normalized.provider,
        deliveryId: normalized.deliveryId,
        eventName: normalized.eventName,
        resourceKind: normalized.resourceKind,
        resourceId: normalized.resourceId,
        resourceName: normalized.resourceName,
        versionName: normalized.versionName,
        versionId: normalized.versionId,
        cursor,
        rawPayload: normalized.raw,
    };

    if (
        normalized.provider === "github"
            ? normalized.eventName === "push"
            : normalized.eventName === "Push Hook" || normalized.eventName === "push"
    ) {
        if (!normalized.versionId || ZERO_SHA.test(normalized.versionId)) {
            return { ...common, type: "resource.deleted" };
        }
        if (normalized.versionName) {
            return {
                ...common,
                type: "resource.versionChanged",
                versionName: normalized.versionName,
                versionId: normalized.versionId,
            };
        }
    }

    if (cursor && (normalized.resourceId || normalized.resourceName)) {
        return { ...common, type: "resource.cursorAdvanced", cursor };
    }

    return { ...common, type: "installation.changed" };
}

function loadConnectorByIdentity(provider: ConnectorProvider, connectorIdOrSlug: string) {
    return Effect.map(
        tryDb((db) =>
            db
                .select()
                .from(connectorsTable)
                .where(
                    and(
                        eq(connectorsTable.provider, provider),
                        eq(connectorsTable.status, "active"),
                        or(
                            eq(connectorsTable.id, connectorIdOrSlug),
                            eq(connectorsTable.slug, connectorIdOrSlug),
                            eq(connectorsTable.appSlug, connectorIdOrSlug)
                        )
                    )
                )
                .limit(1)
        ),
        ([connector]) => connector ?? null
    );
}

export function resolveConnectorWebhookRequest(
    input: ConnectorWebhookRequestInput
): Effect.Effect<ResolvedConnectorWebhookRequest, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        const provider = isKnownConnectorProvider(input.provider)
            ? input.provider
            : yield* Effect.fail(UNSUPPORTED_PROVIDER_ERROR);
        let connector: ConnectorWebhookCandidate | null | undefined;
        if (input.connectorIdOrSlug) {
            connector = yield* loadConnectorByIdentity(provider, input.connectorIdOrSlug);
            if (
                !connector ||
                !verifyConnectorWebhook(provider, {
                    body: input.rawBody,
                    headers: input.headers,
                    webhookSecret: decryptSecret(connector.webhookSecretEncrypted),
                })
            ) {
                return yield* Effect.fail(INVALID_SIGNATURE_ERROR);
            }
        } else {
            const candidates = yield* tryDb((db) =>
                db
                    .select()
                    .from(connectorsTable)
                    .where(and(eq(connectorsTable.provider, provider), eq(connectorsTable.status, "active")))
            );
            connector = candidates.find((candidate) =>
                verifyConnectorWebhook(provider, {
                    body: input.rawBody,
                    headers: input.headers,
                    webhookSecret: decryptSecret(candidate.webhookSecretEncrypted),
                })
            );
            if (!connector) {
                return yield* Effect.fail(INVALID_SIGNATURE_ERROR);
            }
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
