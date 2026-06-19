import * as Effect from "effect/Effect";
import type { ApiError } from "@kiwi/contracts/errors";
import { tryDb, tryDbVoid, type Database, type DatabaseError } from "@kiwi/db/effect";
import {
    connectorInstallationsTable,
    connectorResourceBindingsTable,
    connectorWebhookEventsTable,
} from "@kiwi/db/tables/connectors";
import { syncConnectorResourceGraphSpec } from "@kiwi/worker/sync-connector-resource-graph-spec";
import { and, eq, or } from "drizzle-orm";
import { ow } from "../../../openworkflow";
import { toApiError } from "../../_shared/api-effect";
import type { ConnectorWebhookCandidate, NormalizedConnectorWebhook } from "./request";

type ConnectorResourceBinding = typeof connectorResourceBindingsTable.$inferSelect;

export type HandleConnectorWebhookInput = {
    connector: ConnectorWebhookCandidate;
    event: NormalizedConnectorWebhook;
};

export type HandleConnectorWebhookResult = {
    status: "ignored" | "enqueued" | "duplicate";
    enqueued?: number;
};

function loadWebhookEvent(
    connectorId: string,
    provider: NormalizedConnectorWebhook["provider"],
    deliveryId: string
): Effect.Effect<typeof connectorWebhookEventsTable.$inferSelect | null, DatabaseError, Database> {
    return Effect.map(
        tryDb((db) =>
            db
                .select()
                .from(connectorWebhookEventsTable)
                .where(
                    and(
                        eq(connectorWebhookEventsTable.connectorId, connectorId),
                        eq(connectorWebhookEventsTable.provider, provider),
                        eq(connectorWebhookEventsTable.deliveryId, deliveryId)
                    )
                )
                .limit(1)
        ),
        ([event]) => event ?? null
    );
}

function markWebhookEvent(
    id: string,
    values: { status: "enqueued" | "failed"; errorCode: string | null }
): Effect.Effect<void, DatabaseError, Database> {
    return tryDbVoid((db) =>
        db.update(connectorWebhookEventsTable).set(values).where(eq(connectorWebhookEventsTable.id, id))
    );
}

function enqueueBindingWorkflows(
    bindings: ConnectorResourceBinding[],
    trigger: { versionId: string; cursor: string | null; deliveryId: string }
): Effect.Effect<void, ApiError | DatabaseError, Database> {
    return Effect.gen(function* () {
        const enqueuedBindingIds = new Set<string>();
        yield* Effect.matchEffect(
            Effect.tryPromise({
                try: async () => {
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
                },
                catch: toApiError,
            }),
            {
                onFailure: (error) =>
                    Effect.gen(function* () {
                        yield* tryDbVoid((db) =>
                            Promise.all(
                                bindings.map((binding) =>
                                    db
                                        .update(connectorResourceBindingsTable)
                                        .set(
                                            enqueuedBindingIds.has(binding.id)
                                                ? {
                                                      lastSeenVersionId: trigger.versionId,
                                                      syncStatus: "pending",
                                                      syncErrorCode: null,
                                                  }
                                                : { syncStatus: "failed", syncErrorCode: "enqueue_failed" }
                                        )
                                        .where(eq(connectorResourceBindingsTable.id, binding.id))
                                )
                            )
                        );
                        return yield* Effect.fail(error);
                    }),
                onSuccess: () => Effect.void,
            }
        );

        yield* tryDbVoid((db) =>
            Promise.all(
                bindings.map((binding) =>
                    db
                        .update(connectorResourceBindingsTable)
                        .set({ lastSeenVersionId: trigger.versionId, syncStatus: "pending", syncErrorCode: null })
                        .where(eq(connectorResourceBindingsTable.id, binding.id))
                )
            )
        );
    });
}

function listMatchingBindings(connector: ConnectorWebhookCandidate, event: NormalizedConnectorWebhook) {
    if (
        event.eventType !== "push" ||
        event.deleted ||
        !event.versionName ||
        !event.versionId ||
        (!event.resourceId && !event.resourceName)
    ) {
        return Effect.succeed([]);
    }

    const versionName = event.versionName;

    const resourceWhere = event.resourceId
        ? event.resourceName
            ? or(
                  eq(connectorResourceBindingsTable.providerResourceId, event.resourceId),
                  eq(connectorResourceBindingsTable.resourceDisplayName, event.resourceName)
              )
            : eq(connectorResourceBindingsTable.providerResourceId, event.resourceId)
        : eq(connectorResourceBindingsTable.resourceDisplayName, event.resourceName!);
    return Effect.map(
        tryDb((db) =>
            db
                .select({ binding: connectorResourceBindingsTable })
                .from(connectorResourceBindingsTable)
                .innerJoin(
                    connectorInstallationsTable,
                    eq(connectorResourceBindingsTable.connectorInstallationId, connectorInstallationsTable.id)
                )
                .where(
                    and(
                        eq(connectorInstallationsTable.connectorId, connector.id),
                        eq(connectorResourceBindingsTable.provider, event.provider),
                        eq(connectorResourceBindingsTable.versionName, versionName),
                        eq(connectorResourceBindingsTable.webhookEnabled, true),
                        resourceWhere
                    )
                )
        ),
        (bindingRows) => bindingRows.map((row) => row.binding)
    );
}

export function handleConnectorWebhook({
    connector,
    event,
}: HandleConnectorWebhookInput): Effect.Effect<HandleConnectorWebhookResult, ApiError, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            const bindings = yield* listMatchingBindings(connector, event);
            const status =
                event.eventType !== "push" || event.deleted || bindings.length === 0 ? "ignored" : "enqueued";
            const [ledger] = yield* tryDb((db) =>
                db
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
                    .returning()
            );

            let activeLedger = ledger ?? null;
            if (!activeLedger) {
                const existingLedger = yield* loadWebhookEvent(connector.id, event.provider, event.deliveryId);
                if (existingLedger?.status !== "failed" || status !== "enqueued" || !event.versionId) {
                    return { status: "duplicate" };
                }
                activeLedger = existingLedger;
            }

            if (status === "enqueued" && event.versionId) {
                yield* Effect.matchEffect(
                    enqueueBindingWorkflows(bindings, {
                        versionId: event.versionId,
                        cursor: event.cursor,
                        deliveryId: event.deliveryId,
                    }),
                    {
                        onFailure: (error) =>
                            Effect.gen(function* () {
                                yield* markWebhookEvent(activeLedger.id, {
                                    status: "failed",
                                    errorCode: "enqueue_failed",
                                });
                                return yield* Effect.fail(error);
                            }),
                        onSuccess: () =>
                            activeLedger.status === "failed"
                                ? markWebhookEvent(activeLedger.id, { status: "enqueued", errorCode: null })
                                : Effect.void,
                    }
                );
            }

            return { status, enqueued: status === "enqueued" ? bindings.length : 0 };
        }),
        toApiError
    );
}
