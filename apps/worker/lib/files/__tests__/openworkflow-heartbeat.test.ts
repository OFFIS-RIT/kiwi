import { describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, Worker } from "openworkflow";
import { BackendSqlite } from "openworkflow/sqlite";

const LOST_LEASE_ERROR_MESSAGE = "Failed to extend lease for workflow run";
const HEARTBEAT_INTERVAL_MS = 15_000;

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 5) {
    for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
    }
}

function recordLostLeaseExtensions(backend: BackendSqlite) {
    const lostLeaseErrors: Error[] = [];

    const recordingBackend = new Proxy(backend, {
        get(target, property, receiver) {
            if (property === "extendWorkflowRunLease") {
                return async (...args: Parameters<BackendSqlite["extendWorkflowRunLease"]>) => {
                    try {
                        return await target.extendWorkflowRunLease(...args);
                    } catch (error) {
                        if (error instanceof Error && error.message === LOST_LEASE_ERROR_MESSAGE) {
                            lostLeaseErrors.push(error);
                        }
                        throw error;
                    }
                };
            }

            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    return {
        backend: recordingBackend,
        lostLeaseErrors,
    };
}

describe("patched OpenWorkflow heartbeat", () => {
    test("stops stale lease heartbeats without logging them as heartbeat failures", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "kiwi-openworkflow-heartbeat-"));
        const sqliteBackend = BackendSqlite.connect(join(tempDir, "workflow.sqlite"));
        const { backend, lostLeaseErrors } = recordLostLeaseExtensions(sqliteBackend);
        const workflowStarted = deferred();
        const finishWorkflow = deferred();
        const consoleErrorCalls: unknown[][] = [];
        const originalConsoleError = console.error;
        const worker = new Worker({
            backend,
            workflows: [
                defineWorkflow({ name: "heartbeat-stale-release" }, async () => {
                    workflowStarted.resolve();
                    await finishWorkflow.promise;
                    return null;
                }),
            ],
        });

        console.error = (...args: unknown[]) => {
            consoleErrorCalls.push(args);
        };
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));

        try {
            const run = await backend.createWorkflowRun({
                workflowName: "heartbeat-stale-release",
                version: null,
                idempotencyKey: null,
                config: {},
                context: null,
                input: null,
                parentStepAttemptNamespaceId: null,
                parentStepAttemptId: null,
                availableAt: new Date("2026-06-30T00:00:00.000Z"),
                deadlineAt: null,
            });

            expect(await worker.tick()).toBe(1);
            await workflowStarted.promise;

            const claimedRun = await backend.getWorkflowRun({ workflowRunId: run.id });
            expect(claimedRun?.status).toBe("running");
            expect(claimedRun?.workerId).toEqual(expect.any(String));

            await backend.cancelWorkflowRun({ workflowRunId: run.id });
            const releasedRun = await backend.getWorkflowRun({ workflowRunId: run.id });
            expect(releasedRun?.status).toBe("canceled");
            expect(releasedRun?.workerId).toBeNull();

            jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
            await drainMicrotasks();

            expect(lostLeaseErrors.map((error) => error.message)).toEqual([LOST_LEASE_ERROR_MESSAGE]);
            expect(consoleErrorCalls.filter(([message]) => message === "Heartbeat failed:")).toEqual([]);

            jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
            await drainMicrotasks();

            expect(lostLeaseErrors).toHaveLength(1);
            expect(consoleErrorCalls.filter(([message]) => message === "Heartbeat failed:")).toEqual([]);
        } finally {
            finishWorkflow.resolve();
            await drainMicrotasks(10);
            console.error = originalConsoleError;
            jest.useRealTimers();
            await worker.stop();
            await sqliteBackend.stop();
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
