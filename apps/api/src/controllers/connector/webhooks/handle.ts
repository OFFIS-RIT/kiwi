import { db } from "@kiwi/db";
import {
    connectorInstallationsTable,
    connectorResourceBindingsTable,
    connectorWebhookEventsTable,
} from "@kiwi/db/tables/connectors";
import { syncConnectorResourceGraphSpec } from "@kiwi/worker/sync-connector-resource-graph-spec";
import { and, eq, or } from "drizzle-orm";
import type { ConnectorWebhookCandidate, NormalizedConnectorWebhook } from "../../../lib/connector/webhooks";
import { ow } from "../../../openworkflow";
import { tryApiPromise } from "../../_shared/api-effect";

type ConnectorResourceBinding = typeof connectorResourceBindingsTable.$inferSelect;

export type HandleConnectorWebhookInput = {
    connector: ConnectorWebhookCandidate;
    event: NormalizedConnectorWebhook;
};

export type HandleConnectorWebhookResult = {
    status: "ignored" | "enqueued" | "duplicate";
    enqueued?: number;
};

async function loadWebhookEvent(connectorId: string, provider: NormalizedConnectorWebhook["provider"], deliveryId: string) {
    const [event] = await db
        .select()
        .from(connectorWebhookEventsTable)
        .where(
            and(
                eq(connectorWebhookEventsTable.connectorId, connectorId),
                eq(connectorWebhookEventsTable.provider, provider),
                eq(connectorWebhookEventsTable.deliveryId, deliveryId)
            )
        )
        .limit(1);
    return event ?? null;
}

async function markWebhookEvent(id: string, values: { status: "enqueued" | "failed"; errorCode: string | null }) {
    await db.update(connectorWebhookEventsTable).set(values).where(eq(connectorWebhookEventsTable.id, id));
}

async function enqueueBindingWorkflows(
    bindings: ConnectorResourceBinding[],
    trigger: { versionId: string; cursor: string | null; deliveryId: string }
) {
    const enqueuedBindingIds = new Set<string>();
    try {
        for (const binding of bindings) {
            await ow.runWorkflow(syncConnectorResourceGraphSpec, {
                bindingId: binding.id,
                reason: "webhook",
                versionId: trigger.versionId,
                ...(trigger.cursor ? { cursor: trigger.cursor } : {}),
                deliveryId: trigger.deliveryId,
            });
            enqueuedBindingIds.add(binding.id);
        }
    } catch (error) {
        await Promise.all(
            bindings.map((binding) =>
                db
                    .update(connectorResourceBindingsTable)
                    .set(
                        enqueuedBindingIds.has(binding.id)
                            ? { lastSeenVersionId: trigger.versionId, syncStatus: "pending", syncErrorCode: null }
                            : { syncStatus: "failed", syncErrorCode: "enqueue_failed" }
                    )
                    .where(eq(connectorResourceBindingsTable.id, binding.id))
            )
        );
        throw error;
    }

    await Promise.all(
        bindings.map((binding) =>
            db
                .update(connectorResourceBindingsTable)
                .set({ lastSeenVersionId: trigger.versionId, syncStatus: "pending", syncErrorCode: null })
                .where(eq(connectorResourceBindingsTable.id, binding.id))
        )
    );
}

async function listMatchingBindings(connector: ConnectorWebhookCandidate, event: NormalizedConnectorWebhook) {
    if (
        event.eventType !== "push" ||
        event.deleted ||
        !event.versionName ||
        !event.versionId ||
        (!event.resourceId && !event.resourceName)
    ) {
        return [];
    }

    const resourceWhere = event.resourceId
        ? event.resourceName
            ? or(
                  eq(connectorResourceBindingsTable.providerResourceId, event.resourceId),
                  eq(connectorResourceBindingsTable.resourceDisplayName, event.resourceName)
              )
            : eq(connectorResourceBindingsTable.providerResourceId, event.resourceId)
        : eq(connectorResourceBindingsTable.resourceDisplayName, event.resourceName!);
    const bindingRows = await db
        .select({ binding: connectorResourceBindingsTable })
        .from(connectorResourceBindingsTable)
        .innerJoin(connectorInstallationsTable, eq(connectorResourceBindingsTable.connectorInstallationId, connectorInstallationsTable.id))
        .where(
            and(
                eq(connectorInstallationsTable.connectorId, connector.id),
                eq(connectorResourceBindingsTable.provider, event.provider),
                eq(connectorResourceBindingsTable.versionName, event.versionName),
                eq(connectorResourceBindingsTable.webhookEnabled, true),
                resourceWhere
            )
        );
    return bindingRows.map((row) => row.binding);
}

export function handleConnectorWebhook({ connector, event }: HandleConnectorWebhookInput) {
    return tryApiPromise(async () => {
        const bindings = await listMatchingBindings(connector, event);
        const status = event.eventType !== "push" || event.deleted || bindings.length === 0 ? "ignored" : "enqueued";
        const [ledger] = await db
            .insert(connectorWebhookEventsTable)
            .values({
                connectorId: connector.id,
                provider: event.provider,
                deliveryId: event.deliveryId,
                eventName: event.eventName,
                providerResourceId: event.resourceId,
                versionName: event.versionName,
                versionId: event.versionId,
                status,
            })
            .onConflictDoNothing({
                target: [
                    connectorWebhookEventsTable.connectorId,
                    connectorWebhookEventsTable.provider,
                    connectorWebhookEventsTable.deliveryId,
                ],
            })
            .returning();
    
        let activeLedger = ledger ?? null;
        if (!activeLedger) {
            const existingLedger = await loadWebhookEvent(connector.id, event.provider, event.deliveryId);
            if (existingLedger?.status !== "failed" || status !== "enqueued" || !event.versionId) {
                return { status: "duplicate" };
            }
            activeLedger = existingLedger;
        }
    
        if (status === "enqueued" && event.versionId) {
            try {
                await enqueueBindingWorkflows(bindings, { versionId: event.versionId, cursor: event.cursor, deliveryId: event.deliveryId });
                if (activeLedger.status === "failed") {
                    await markWebhookEvent(activeLedger.id, { status: "enqueued", errorCode: null });
                }
            } catch (error) {
                await markWebhookEvent(activeLedger.id, { status: "failed", errorCode: "enqueue_failed" });
                throw error;
            }
        }
    
        return { status, enqueued: status === "enqueued" ? bindings.length : 0 };
    });
}
