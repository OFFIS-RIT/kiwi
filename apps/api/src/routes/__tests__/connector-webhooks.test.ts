import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { connectorResourceBindingsTable } from "@kiwi/db/tables/connectors";

type SelectResult = { kind: "where"; value: unknown[] } | { kind: "limit"; value: unknown[] };

const connector = {
    id: "connector-1",
    provider: "github",
    status: "active",
    webhookSecretEncrypted: "encrypted-secret",
};

const bindingOne = { id: "binding-1" };
const bindingTwo = { id: "binding-2" };
const ledger = { id: "event-1", status: "enqueued" };
const failedLedger = { id: "event-1", status: "failed" };

const selectResults: SelectResult[] = [];
const insertResults: unknown[][] = [];
const insertValues: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const joins: unknown[] = [];
const wheres: unknown[] = [];
const workflowInputs: Array<Record<string, unknown>> = [];
let workflowFailureIndex: number | null = null;

function selectQuery() {
    const result = selectResults.shift();
    if (!result) {
        throw new Error("Unexpected select call");
    }

    const chain = {
        from: () => chain,
        innerJoin: (...args: unknown[]) => {
            joins.push(args);
            return chain;
        },
        where: (clause?: unknown) => {
            wheres.push(clause);
            return result.kind === "where" ? result.value : chain;
        },
        limit: () => result.value,
    };
    return chain;
}

const db = {
    select: () => selectQuery(),
    insert: () => ({
        values: (values: Record<string, unknown>) => {
            insertValues.push(values);
            return {
                onConflictDoNothing: () => ({
                    returning: () => insertResults.shift() ?? [],
                }),
            };
        },
    }),
    update: () => ({
        set: (values: Record<string, unknown>) => ({
            where: async () => {
                updates.push(values);
                return undefined;
            },
        }),
    }),
};

function runMockDbEffect(thunk: (database: typeof db) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(db);
    return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
}

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed(db),
    DatabaseError: class DatabaseError extends Error {},
    DatabaseLayer: Layer.empty,
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
    tryDb: runMockDbEffect,
    tryDbVoid: (thunk: (database: typeof db) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) =>
        Effect.asVoid(runMockDbEffect(thunk)),
}));

mock.module("../../lib/connectors", () => ({
    decryptSecret: () => "secret",
}));

mock.module("../../workflow", () => ({
    wo: {
        runWorkflow: async (_spec: unknown, input: Record<string, unknown>) => {
            workflowInputs.push(input);
            if (workflowFailureIndex === workflowInputs.length) {
                throw new Error("enqueue failed");
            }
            return { workflowRun: { id: `run-${workflowInputs.length}` } };
        },
    },
}));

function signedGitHubRequest(body: string, connectorIdOrSlug?: string) {
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    return new Request(
        `http://localhost/connectors/webhooks/github${connectorIdOrSlug ? `/${connectorIdOrSlug}` : ""}`,
        {
            method: "POST",
            headers: {
                "x-hub-signature-256": signature,
                "x-github-event": "push",
                "x-github-delivery": "delivery-1",
            },
            body,
        }
    );
}

function pushBody() {
    return JSON.stringify({
        ref: "refs/heads/main",
        after: "commit-new",
        repository: { id: 7, full_name: "acme/app" },
    });
}

function containsReference(value: unknown, expected: unknown, seen = new Set<object>()): boolean {
    if (value === expected) {
        return true;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
        return false;
    }
    seen.add(value);
    for (const nested of Object.values(value)) {
        if (containsReference(nested, expected, seen)) {
            return true;
        }
    }
    return false;
}

// Dynamic import is required so Bun module mocks are installed before the route module is evaluated.
const { connectorWebhookRoute } = await import("../connector-webhooks");

describe("connector webhook route", () => {
    beforeEach(() => {
        selectResults.length = 0;
        updates.length = 0;
        insertResults.length = 0;
        insertValues.length = 0;
        joins.length = 0;
        wheres.length = 0;
        workflowInputs.length = 0;
        workflowFailureIndex = null;
    });

    test("returns a structured 400 for signed invalid JSON", async () => {
        selectResults.push({ kind: "where", value: [connector] });

        const response = await connectorWebhookRoute.handle(signedGitHubRequest("not-json"));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            status: "error",
            code: "INVALID_CHAT_REQUEST",
        });
        expect(insertResults).toEqual([]);
    });

    test("loads one connector when the webhook URL includes connector identity", async () => {
        selectResults.push({ kind: "limit", value: [connector] }, { kind: "where", value: [{ binding: bindingOne }] });
        insertResults.push([ledger]);

        const response = await connectorWebhookRoute.handle(signedGitHubRequest(pushBody(), "connector-1"));

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            status: "success",
            data: { status: "enqueued", enqueued: 1 },
        });
        expect(workflowInputs.map((input) => input.bindingId)).toEqual(["binding-1"]);
        expect(selectResults).toEqual([]);
    });

    test("marks failed workflow enqueues so delivery retries can recover", async () => {
        selectResults.push(
            { kind: "where", value: [connector] },
            { kind: "where", value: [{ binding: bindingOne }, { binding: bindingTwo }] }
        );
        insertResults.push([ledger]);
        workflowFailureIndex = 2;

        const response = await connectorWebhookRoute.handle(signedGitHubRequest(pushBody()));

        expect(response.status).toBe(500);
        expect(workflowInputs.map((input) => input.bindingId)).toEqual(["binding-1", "binding-2"]);
        expect(updates).toContainEqual({ lastSeenVersionId: "commit-new", syncStatus: "pending", syncErrorCode: null });
        expect(workflowInputs).toContainEqual({
            bindingId: "binding-1",
            reason: "webhook",
            versionId: "commit-new",
            deliveryId: "delivery-1",
        });
        expect(insertValues[0]).toMatchObject({
            providerResourceId: "7",
            versionName: "main",
            versionId: "commit-new",
        });
        expect(updates).toContainEqual({ syncStatus: "failed", syncErrorCode: "enqueue_failed" });
        expect(updates).toContainEqual({ status: "failed", errorCode: "enqueue_failed" });
        expect(joins).toHaveLength(1);
        expect(wheres.some((where) => containsReference(where, connectorResourceBindingsTable.resourceKind))).toBe(
            true
        );
    });

    test("re-enqueues failed duplicate webhook deliveries", async () => {
        selectResults.push(
            { kind: "where", value: [connector] },
            { kind: "where", value: [{ binding: bindingOne }, { binding: bindingTwo }] },
            { kind: "limit", value: [failedLedger] }
        );
        insertResults.push([]);

        const response = await connectorWebhookRoute.handle(signedGitHubRequest(pushBody()));

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            status: "success",
            data: { status: "enqueued", enqueued: 2 },
        });
        expect(workflowInputs.map((input) => input.bindingId)).toEqual(["binding-1", "binding-2"]);
        expect(updates).toContainEqual({ status: "enqueued", errorCode: null });
    });
});
