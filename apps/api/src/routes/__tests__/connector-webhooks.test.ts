import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";

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
const updates: Array<Record<string, unknown>> = [];
const joins: unknown[] = [];
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
        where: () => (result.kind === "where" ? result.value : chain),
        limit: () => result.value,
    };
    return chain;
}

mock.module("@kiwi/db", () => ({
    db: {
        select: () => selectQuery(),
        insert: () => ({
            values: () => ({
                onConflictDoNothing: () => ({
                    returning: () => insertResults.shift() ?? [],
                }),
            }),
        }),
        update: () => ({
            set: (values: Record<string, unknown>) => ({
                where: async () => {
                    updates.push(values);
                    return undefined;
                },
            }),
        }),
    },
}));

mock.module("../../lib/connectors", () => ({
    decryptSecret: () => "secret",
}));

mock.module("../../openworkflow", () => ({
    ow: {
        runWorkflow: async (_spec: unknown, input: Record<string, unknown>) => {
            workflowInputs.push(input);
            if (workflowFailureIndex === workflowInputs.length) {
                throw new Error("enqueue failed");
            }
            return { workflowRun: { id: `run-${workflowInputs.length}` } };
        },
    },
}));

function signedGitHubRequest(body: string) {
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    return new Request("http://localhost/connectors/webhooks/github", {
        method: "POST",
        headers: {
            "x-hub-signature-256": signature,
            "x-github-event": "push",
            "x-github-delivery": "delivery-1",
        },
        body,
    });
}

function pushBody() {
    return JSON.stringify({
        ref: "refs/heads/main",
        after: "commit-new",
        repository: { id: 7, full_name: "acme/app" },
    });
}

// Dynamic import is required so Bun module mocks are installed before the route module is evaluated.
const { connectorWebhookRoute } = await import("../connector-webhooks");

describe("connector webhook route", () => {
    beforeEach(() => {
        selectResults.length = 0;
        insertResults.length = 0;
        updates.length = 0;
        joins.length = 0;
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
        expect(updates).toContainEqual({ lastSeenCommitSha: "commit-new", syncStatus: "pending", syncErrorCode: null });
        expect(updates).toContainEqual({ syncStatus: "failed", syncErrorCode: "enqueue_failed" });
        expect(updates).toContainEqual({ status: "failed", errorCode: "enqueue_failed" });
        expect(joins).toHaveLength(1);
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
