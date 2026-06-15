import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@kiwi/db";
import {
    connectorWebhookEventsTable,
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
        return new Response(JSON.stringify(errorResponse("Invalid webhook signature", API_ERROR_CODES.FORBIDDEN)), {
            status: 403,
            headers: { "Content-Type": "application/json" },
        });
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const eventName =
        provider === "github"
            ? request.headers.get("x-github-event") || "unknown"
            : request.headers.get("x-gitlab-event") || String(payload.event_name ?? "unknown");
    const deliveryId =
        provider === "github"
            ? request.headers.get("x-github-delivery") || "missing"
            : request.headers.get("x-gitlab-webhook-uuid") || `${String(payload.event_name ?? "event")}:${String(payload.after ?? Date.now())}`;
    const normalized = provider === "github" ? normalizeGitHub(payload, eventName, deliveryId) : normalizeGitLab(payload, eventName, deliveryId);
    const isPush = provider === "github" ? eventName === "push" : eventName === "Push Hook" || normalized.eventName === "push";

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
        bindings = await db
            .select()
            .from(repositoryGraphBindingsTable)
            .where(
                and(
                    eq(repositoryGraphBindingsTable.provider, provider),
                    eq(repositoryGraphBindingsTable.branch, normalized.branch),
                    eq(repositoryGraphBindingsTable.webhookEnabled, true),
                    repositoryWhere
                )
            );
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

    if (!ledger) {
        return new Response(JSON.stringify(successResponse({ status: "duplicate" })), {
            status: 202,
            headers: { "Content-Type": "application/json" },
        });
    }

    if (status === "enqueued" && normalized.commitSha) {
        for (const binding of bindings) {
            await db
                .update(repositoryGraphBindingsTable)
                .set({ lastSeenCommitSha: normalized.commitSha, syncStatus: "pending", syncErrorCode: null })
                .where(eq(repositoryGraphBindingsTable.id, binding.id));
            await ow.runWorkflow(syncRepositoryGraphSpec, {
                bindingId: binding.id,
                reason: "webhook",
                commitSha: normalized.commitSha,
                deliveryId,
            });
        }
    }

    return new Response(JSON.stringify(successResponse({ status, enqueued: status === "enqueued" ? bindings.length : 0 })), {
        status: 202,
        headers: { "Content-Type": "application/json" },
    });
}

export const connectorWebhookRoute = new Elysia().post("/connectors/webhooks/:provider", async ({ params, request }) => {
    if (params.provider !== "github" && params.provider !== "gitlab") {
        return new Response(JSON.stringify(errorResponse("Unsupported provider", API_ERROR_CODES.INVALID_CHAT_REQUEST)), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
    }
    return handleWebhook(params.provider, request);
});
