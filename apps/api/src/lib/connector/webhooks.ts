import { db } from "@kiwi/db";
import { connectorsTable, type ConnectorProvider } from "@kiwi/db/tables/connectors";
import { normalizeConnectorWebhook, verifyConnectorWebhook, type ConnectorResourceKind } from "@kiwi/connectors";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "../connectors";

const CONNECTOR_PROVIDERS: Record<ConnectorProvider, true> = { github: true, gitlab: true };
const ZERO_SHA = /^0+$/;

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

export function parseConnectorWebhookProvider(provider: string): ConnectorProvider | null {
    return Object.hasOwn(CONNECTOR_PROVIDERS, provider) ? (provider as ConnectorProvider) : null;
}

export async function listActiveConnectorWebhookCandidates(provider: ConnectorProvider) {
    return db
        .select()
        .from(connectorsTable)
        .where(and(eq(connectorsTable.provider, provider), eq(connectorsTable.status, "active")));
}

export function verifyConnectorWebhookCandidate(options: {
    provider: ConnectorProvider;
    connector: ConnectorWebhookCandidate;
    headers: Headers;
    rawBody: string;
}) {
    return verifyConnectorWebhook(options.provider, {
        body: options.rawBody,
        headers: options.headers,
        webhookSecret: decryptSecret(options.connector.webhookSecretEncrypted),
    });
}

export function parseConnectorWebhookPayload(rawBody: string): Record<string, unknown> | null {
    try {
        const payload = JSON.parse(rawBody);
        return payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export function readConnectorWebhookEventName(provider: ConnectorProvider, headers: Headers, payload: Record<string, unknown>) {
    return provider === "github"
        ? headers.get("x-github-event") || "unknown"
        : headers.get("x-gitlab-event") || String(payload.event_name ?? "unknown");
}

export function readConnectorWebhookDeliveryId(provider: ConnectorProvider, headers: Headers, payload: Record<string, unknown>) {
    return provider === "github"
        ? headers.get("x-github-delivery") || "missing"
        : headers.get("x-gitlab-webhook-uuid") || `${String(payload.event_name ?? "event")}:${String(payload.after ?? Date.now())}`;
}

export function normalizeConnectorWebhookPayload(options: {
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
