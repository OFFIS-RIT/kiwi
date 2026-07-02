import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "@kiwi/db/drizzle";
import { disposeDatabaseRuntime, runDatabaseEffect, tryDb } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";

import { DrizzleWorkflowBackend, type StartWorkflowRunParams, type WorkflowRun } from "../backend";

const testRunNamespace = `workflow-backend-postgres-${randomUUID()}`;
const usedNamespaces = new Set<string>();
let namespaceSequence = 0;

function createWorkflowRunParams(
    workflowName: string,
    overrides: Partial<StartWorkflowRunParams> = {}
): StartWorkflowRunParams {
    return {
        workflowName,
        version: null,
        idempotencyKey: null,
        config: {},
        context: null,
        input: null,
        availableAt: new Date(Date.now() - 60_000),
        deadlineAt: null,
        ...overrides,
    };
}

function requireWorkflowRun(workflowRun: WorkflowRun | null): WorkflowRun {
    expect(workflowRun).not.toBeNull();
    if (!workflowRun) {
        throw new Error("Expected workflow run");
    }
    return workflowRun;
}

async function execute(query: SQL): Promise<void> {
    await runDatabaseEffect(tryDb((db) => Effect.asVoid(db.execute(query))));
}

async function detectDatabaseUnavailableReason(): Promise<string | null> {
    if (!process.env.DATABASE_URL) {
        return "DATABASE_URL is not set";
    }

    try {
        await execute(sql`SELECT 1`);
        return null;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `DATABASE_URL is set but Postgres is unavailable: ${message}`;
    }
}

const databaseUnavailableReason = await detectDatabaseUnavailableReason();
if (databaseUnavailableReason !== null) {
    console.warn(`Skipping Postgres workflow backend lease contracts: ${databaseUnavailableReason}`);
}
const postgresTest = test.skipIf(databaseUnavailableReason !== null);

async function cleanupNamespace(namespaceId: string): Promise<void> {
    await execute(sql`DELETE FROM workflow_signal_sends WHERE "namespace_id" = ${namespaceId}`);
    await execute(sql`DELETE FROM workflow_signals WHERE "namespace_id" = ${namespaceId}`);
    await execute(sql`DELETE FROM workflow_step_attempts WHERE "namespace_id" = ${namespaceId}`);
    await execute(sql`DELETE FROM workflow_runs WHERE "namespace_id" = ${namespaceId}`);
}

async function expireWorkflowRunLease(namespaceId: string, workflowRunId: string): Promise<void> {
    await execute(sql`
        UPDATE workflow_runs
        SET "available_at" = NOW() - INTERVAL '1 second',
            "updated_at" = NOW()
        WHERE "namespace_id" = ${namespaceId}
          AND "id" = ${workflowRunId}
    `);
}

async function withBackend<T>(body: (backend: DrizzleWorkflowBackend, namespaceId: string) => Promise<T>): Promise<T> {
    const namespaceId = `${testRunNamespace}-${++namespaceSequence}`;
    usedNamespaces.add(namespaceId);
    const backend = new DrizzleWorkflowBackend({ namespaceId });

    await cleanupNamespace(namespaceId);
    try {
        return await body(backend, namespaceId);
    } finally {
        await cleanupNamespace(namespaceId);
        await backend.stop();
    }
}

afterAll(async () => {
    try {
        if (databaseUnavailableReason !== null) {
            return;
        }

        for (const namespaceId of usedNamespaces) {
            await cleanupNamespace(namespaceId);
        }
    } finally {
        await disposeDatabaseRuntime().catch(() => {});
    }
});

if (databaseUnavailableReason !== null) {
    test.skip(`skips Postgres workflow backend lease contracts: ${databaseUnavailableReason}`, () => {});
}

describe("DrizzleWorkflowBackend Postgres lease contracts", () => {
    postgresTest("claiming a pending run records the running owner and lets that owner extend the lease", async () => {
        await withBackend(async (backend) => {
            const run = await backend.startWorkflowRun(createWorkflowRunParams("claim-and-extend"));

            const claimed = requireWorkflowRun(
                await backend.claimNextRunnableWorkflow({ workerId: "worker-one", leaseDurationMs: 30_000 })
            );

            expect(claimed.id).toBe(run.id);
            expect(claimed.status).toBe("running");
            expect(claimed.workerId).toBe("worker-one");
            expect(claimed.attempts).toBe(1);
            expect(claimed.startedAt).toBeInstanceOf(Date);
            expect(claimed.availableAt).toBeInstanceOf(Date);

            const extended = await backend.heartbeatClaim({
                workflowRunId: run.id,
                workerId: "worker-one",
                leaseDurationMs: 120_000,
            });

            expect(extended.id).toBe(run.id);
            expect(extended.status).toBe("running");
            expect(extended.workerId).toBe("worker-one");
            expect(extended.attempts).toBe(1);
            expect(extended.availableAt?.getTime()).toBeGreaterThan(claimed.availableAt?.getTime() ?? 0);
        });
    });

    postgresTest("non-owners cannot extend or complete an owned running run", async () => {
        await withBackend(async (backend) => {
            const run = await backend.startWorkflowRun(createWorkflowRunParams("reject-non-owner"));
            requireWorkflowRun(await backend.claimNextRunnableWorkflow({ workerId: "worker-one", leaseDurationMs: 120_000 }));

            await expect(
                backend.heartbeatClaim({
                    workflowRunId: run.id,
                    workerId: "worker-two",
                    leaseDurationMs: 120_000,
                })
            ).rejects.toThrow("Failed to extend lease for workflow run");
            await expect(
                backend.completeClaimedWorkflow({ workflowRunId: run.id, workerId: "worker-two", output: "stolen" })
            ).rejects.toThrow("Failed to mark workflow run completed");

            const stillOwned = requireWorkflowRun(await backend.getWorkflowRun({ workflowRunId: run.id }));
            expect(stillOwned.status).toBe("running");
            expect(stillOwned.workerId).toBe("worker-one");
            expect(stillOwned.output).toBeNull();
            expect(stillOwned.attempts).toBe(1);

            const completed = await backend.completeClaimedWorkflow({
                workflowRunId: run.id,
                workerId: "worker-one",
                output: "owner-finished",
            });
            expect(completed.status).toBe("completed");
            expect(completed.output).toBe("owner-finished");
            expect(completed.workerId).toBeNull();
        });
    });

    postgresTest("expired leases can be reclaimed and the stale owner cannot heartbeat or complete", async () => {
        await withBackend(async (backend, namespaceId) => {
            const run = await backend.startWorkflowRun(createWorkflowRunParams("reclaim-expired-lease"));
            requireWorkflowRun(await backend.claimNextRunnableWorkflow({ workerId: "worker-one", leaseDurationMs: 120_000 }));
            await expireWorkflowRunLease(namespaceId, run.id);

            const reclaimed = requireWorkflowRun(
                await backend.claimNextRunnableWorkflow({ workerId: "worker-two", leaseDurationMs: 120_000 })
            );
            expect(reclaimed.id).toBe(run.id);
            expect(reclaimed.status).toBe("running");
            expect(reclaimed.workerId).toBe("worker-two");
            expect(reclaimed.attempts).toBe(2);

            await expect(
                backend.heartbeatClaim({
                    workflowRunId: run.id,
                    workerId: "worker-one",
                    leaseDurationMs: 120_000,
                })
            ).rejects.toThrow("Failed to extend lease for workflow run");
            await expect(
                backend.completeClaimedWorkflow({ workflowRunId: run.id, workerId: "worker-one", output: "stale-finish" })
            ).rejects.toThrow("Failed to mark workflow run completed");

            const completed = await backend.completeClaimedWorkflow({
                workflowRunId: run.id,
                workerId: "worker-two",
                output: "reclaimed-finished",
            });
            expect(completed.status).toBe("completed");
            expect(completed.output).toBe("reclaimed-finished");
            expect(completed.workerId).toBeNull();
        });
    });

    postgresTest("runs past their workflow deadline fail instead of being claimed", async () => {
        await withBackend(async (backend) => {
            const run = await backend.startWorkflowRun(
                createWorkflowRunParams("deadline-expired", { deadlineAt: new Date(Date.now() - 60_000) })
            );

            const claimed = await backend.claimNextRunnableWorkflow({ workerId: "worker-one", leaseDurationMs: 120_000 });
            expect(claimed).toBeNull();

            const failed = requireWorkflowRun(await backend.getWorkflowRun({ workflowRunId: run.id }));
            expect(failed.status).toBe("failed");
            expect(failed.workerId).toBeNull();
            expect(failed.availableAt).toBeNull();
            expect(failed.finishedAt).toBeInstanceOf(Date);
            expect(failed.attempts).toBe(0);
            expect(failed.error).toEqual({ message: "Workflow run deadline exceeded" });
        });
    });
});
