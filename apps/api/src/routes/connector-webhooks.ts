import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@kiwi/db";
import {
    connectorWebhookEventsTable,
    connectorInstallationsTable,
    connectorsTable,
    repositoryGraphBindingsTable,
    type ConnectorProvider,
} from "@kiwi/db/tables/connectors";
import { syncRepositoryGraphSpec } from "@kiwi/worker/sync-repository-graph-spec";
import { and, eq, or } from "drizzle-orm";
import Elysia from "elysia";
import { decryptSecret } from "../lib/connectors";
import { ow } from "../openworkflow";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";
import type { ApiErrorCode } from "../types";

type NormalizedPush = {
    eventName: string;
    deliveryId: string;
    providerRepositoryId: string | null;
    repositoryFullName: string | null;
    branch: string | null;
    commitSha: string | null;
    deleted: boolean;
};

const ZERO_SHA = /^0+$/;

function equalSecret(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
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

function verifyGitHubSignature(rawBody: string, signatureHeader: string | null, secret: string) {
    if (!signatureHeader?.startsWith("sha256=")) {
        return false;
    }
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    return equalSecret(signatureHeader, expected);
}

function normalizeBranch(ref: unknown) {
    if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
        return null;
    }
    return ref.slice("refs/heads/".length);
}

function normalizeGitHub(payload: Record<string, unknown>, eventName: string, deliveryId: string): NormalizedPush {
    const repository = payload.repository && typeof payload.repository === "object" ? payload.repository : null;
    const repo = repository as { id?: unknown; full_name?: unknown } | null;
    const commitSha = typeof payload.after === "string" ? payload.after : null;
    return {
        eventName,
        deliveryId,
        providerRepositoryId: repo?.id === undefined ? null : String(repo.id),
        repositoryFullName: typeof repo?.full_name === "string" ? repo.full_name : null,
        branch: normalizeBranch(payload.ref),
        commitSha,
        deleted: !commitSha || ZERO_SHA.test(commitSha),
    };
}

function normalizeGitLab(payload: Record<string, unknown>, eventName: string, deliveryId: string): NormalizedPush {
    const project = payload.project && typeof payload.project === "object" ? payload.project : null;
    const repo = project as { id?: unknown; path_with_namespace?: unknown } | null;
    const commitSha = typeof payload.after === "string" ? payload.after : null;
    return {
        eventName,
        deliveryId,
        providerRepositoryId: repo?.id === undefined ? null : String(repo.id),
        repositoryFullName: typeof repo?.path_with_namespace === "string" ? repo.path_with_namespace : null,
        branch: normalizeBranch(payload.ref),
        commitSha,
        deleted: !commitSha || ZERO_SHA.test(commitSha),
    };
}
function parseWebhookPayload(rawBody: string): Record<string, unknown> | null {
    try {
        const payload = JSON.parse(rawBody);
        return payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

async function loadWebhookEvent(connectorId: string, provider: ConnectorProvider, deliveryId: string) {
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
    bindings: Array<typeof repositoryGraphBindingsTable.$inferSelect>,
    commitSha: string,
    deliveryId: string
) {
    const enqueuedBindingIds = new Set<string>();
    try {
        for (const binding of bindings) {
            await ow.runWorkflow(syncRepositoryGraphSpec, {
                bindingId: binding.id,
                reason: "webhook",
                commitSha,
                deliveryId,
            });
            enqueuedBindingIds.add(binding.id);
        }
    } catch (error) {
        await Promise.all(
            bindings.map((binding) =>
                db
                    .update(repositoryGraphBindingsTable)
                    .set(
                        enqueuedBindingIds.has(binding.id)
                            ? { lastSeenCommitSha: commitSha, syncStatus: "pending", syncErrorCode: null }
                            : { syncStatus: "failed", syncErrorCode: "enqueue_failed" }
                    )
                    .where(eq(repositoryGraphBindingsTable.id, binding.id))
            )
        );
        throw error;
    }

    await Promise.all(
        bindings.map((binding) =>
            db
                .update(repositoryGraphBindingsTable)
                .set({ lastSeenCommitSha: commitSha, syncStatus: "pending", syncErrorCode: null })
                .where(eq(repositoryGraphBindingsTable.id, binding.id))
        )
    );
}

async function findVerifiedConnector(provider: ConnectorProvider, request: Request, rawBody: string) {
    const connectors = await db
        .select()
        .from(connectorsTable)
        .where(and(eq(connectorsTable.provider, provider), eq(connectorsTable.status, "active")));

    for (const connector of connectors) {
        const secret = decryptSecret(connector.webhookSecretEncrypted);
        if (provider === "github") {
            if (verifyGitHubSignature(rawBody, request.headers.get("x-hub-signature-256"), secret)) {
                return connector;
            }
        } else if (equalSecret(request.headers.get("x-gitlab-token") ?? "", secret)) {
            return connector;
        }
    }

    return null;
}

async function handleWebhook(provider: ConnectorProvider, request: Request) {
    const rawBody = await request.text();
    const connector = await findVerifiedConnector(provider, request, rawBody);
    if (!connector) {
        return jsonError("Invalid webhook signature", API_ERROR_CODES.FORBIDDEN, 403);
    }

    const payload = parseWebhookPayload(rawBody);
    if (!payload) {
        return jsonError("Invalid webhook payload", API_ERROR_CODES.INVALID_CHAT_REQUEST, 400);
    }
    const eventName =
        provider === "github"
            ? request.headers.get("x-github-event") || "unknown"
            : request.headers.get("x-gitlab-event") || String(payload.event_name ?? "unknown");
    const deliveryId =
        provider === "github"
            ? request.headers.get("x-github-delivery") || "missing"
            : request.headers.get("x-gitlab-webhook-uuid") ||
              `${String(payload.event_name ?? "event")}:${String(payload.after ?? Date.now())}`;
    const normalized =
        provider === "github"
            ? normalizeGitHub(payload, eventName, deliveryId)
            : normalizeGitLab(payload, eventName, deliveryId);
    const isPush =
        provider === "github" ? eventName === "push" : eventName === "Push Hook" || normalized.eventName === "push";

    let bindings: Array<typeof repositoryGraphBindingsTable.$inferSelect> = [];
    if (
        isPush &&
        normalized.branch &&
        normalized.commitSha &&
        !normalized.deleted &&
        (normalized.providerRepositoryId || normalized.repositoryFullName)
    ) {
        const repositoryWhere =
            normalized.providerRepositoryId && normalized.repositoryFullName
                ? or(
                      eq(repositoryGraphBindingsTable.providerRepositoryId, normalized.providerRepositoryId),
                      eq(repositoryGraphBindingsTable.repositoryFullName, normalized.repositoryFullName)
                  )
                : normalized.providerRepositoryId
                  ? eq(repositoryGraphBindingsTable.providerRepositoryId, normalized.providerRepositoryId)
                  : eq(repositoryGraphBindingsTable.repositoryFullName, normalized.repositoryFullName!);
        const bindingRows = await db
            .select({ binding: repositoryGraphBindingsTable })
            .from(repositoryGraphBindingsTable)
            .innerJoin(
                connectorInstallationsTable,
                eq(repositoryGraphBindingsTable.connectorInstallationId, connectorInstallationsTable.id)
            )
            .where(
                and(
                    eq(connectorInstallationsTable.connectorId, connector.id),
                    eq(repositoryGraphBindingsTable.provider, provider),
                    eq(repositoryGraphBindingsTable.branch, normalized.branch),
                    eq(repositoryGraphBindingsTable.webhookEnabled, true),
                    repositoryWhere
                )
            );
        bindings = bindingRows.map((row) => row.binding);
    }

    const status = !isPush || normalized.deleted || bindings.length === 0 ? "ignored" : "enqueued";
    const [ledger] = await db
        .insert(connectorWebhookEventsTable)
        .values({
            connectorId: connector.id,
            provider,
            deliveryId,
            eventName,
            providerRepositoryId: normalized.providerRepositoryId,
            branch: normalized.branch,
            commitSha: normalized.commitSha,
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
        const existingLedger = await loadWebhookEvent(connector.id, provider, deliveryId);
        if (existingLedger?.status !== "failed" || status !== "enqueued" || !normalized.commitSha) {
            return jsonSuccess({ status: "duplicate" }, 202);
        }
        activeLedger = existingLedger;
    }

    if (status === "enqueued" && normalized.commitSha) {
        try {
            await enqueueBindingWorkflows(bindings, normalized.commitSha, deliveryId);
            if (activeLedger.status === "failed") {
                await markWebhookEvent(activeLedger.id, { status: "enqueued", errorCode: null });
            }
        } catch (error) {
            await markWebhookEvent(activeLedger.id, { status: "failed", errorCode: "enqueue_failed" });
            throw error;
        }
    }

    return jsonSuccess({ status, enqueued: status === "enqueued" ? bindings.length : 0 }, 202);
}

export const connectorWebhookRoute = new Elysia().post(
    "/connectors/webhooks/:provider",
    async ({ params, request }) => {
        if (params.provider !== "github" && params.provider !== "gitlab") {
            return new Response(
                JSON.stringify(errorResponse("Unsupported provider", API_ERROR_CODES.INVALID_CHAT_REQUEST)),
                {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }
        return handleWebhook(params.provider, request);
    }
);
