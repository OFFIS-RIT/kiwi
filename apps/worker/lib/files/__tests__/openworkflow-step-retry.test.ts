import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendSqlite } from "openworkflow/sqlite";

type SqliteStatement = {
    run: (...args: unknown[]) => unknown;
};

type SqliteDatabase = {
    prepare: (sql: string) => SqliteStatement;
};

function getSqliteDatabase(backend: BackendSqlite): SqliteDatabase {
    const db = Reflect.get(backend, "db");
    if (!isSqliteDatabase(db)) {
        throw new Error("Expected BackendSqlite test database handle");
    }

    return db;
}

function isSqliteDatabase(value: unknown): value is SqliteDatabase {
    return value !== null && typeof value === "object" && "prepare" in value && typeof value.prepare === "function";
}

function expireWorkflowLease(backend: BackendSqlite, workflowRunId: string) {
    const db = getSqliteDatabase(backend);
    db.prepare(`
        UPDATE "workflow_runs"
        SET "available_at" = '1970-01-01T00:00:00.000Z',
            "updated_at" = '1970-01-01T00:00:00.000Z'
        WHERE "id" = ?
    `).run(workflowRunId);
}

describe("patched OpenWorkflow step retry", () => {
    test("does not reclaim a workflow while a function step attempt is still running", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "kiwi-openworkflow-"));
        const backend = BackendSqlite.connect(join(tempDir, "workflow.sqlite"));

        try {
            const run = await backend.createWorkflowRun({
                workflowName: "function-step-retry-after-failed-attempt",
                version: null,
                idempotencyKey: null,
                config: {},
                context: null,
                input: null,
                parentStepAttemptNamespaceId: null,
                parentStepAttemptId: null,
                availableAt: new Date(0),
                deadlineAt: null,
            });
            await backend.claimWorkflowRun({ workerId: "worker-1", leaseDurationMs: 30_000 });
            const staleAttempt = await backend.createStepAttempt({
                workflowRunId: run.id,
                workerId: "worker-1",
                stepName: "blocked-step",
                kind: "function",
                config: {},
                context: null,
            });

            expireWorkflowLease(backend, run.id);
            expect(await backend.claimWorkflowRun({ workerId: "worker-2", leaseDurationMs: 30_000 })).toBeNull();
            await backend.failStepAttempt({
                workflowRunId: run.id,
                stepAttemptId: staleAttempt.id,
                workerId: "worker-1",
                error: { message: "stale attempt failed" },
            });
            await backend.claimWorkflowRun({ workerId: "worker-2", leaseDurationMs: 30_000 });

            const attemptsAfterClaim = await backend.listStepAttempts({ workflowRunId: run.id });
            expect(attemptsAfterClaim.data.map((attempt) => attempt.status)).toEqual(["failed"]);

            await backend.createStepAttempt({
                workflowRunId: run.id,
                workerId: "worker-2",
                stepName: "blocked-step",
                kind: "function",
                config: {},
                context: null,
            });

            const attemptsAfterRetryStart = await backend.listStepAttempts({ workflowRunId: run.id });
            expect(attemptsAfterRetryStart.data.map((attempt) => attempt.status).sort()).toEqual(["failed", "running"]);
        } finally {
            await backend.stop();
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
