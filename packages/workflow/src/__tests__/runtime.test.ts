import { describe, expect, test } from "bun:test";

import {
    WorkflowClient,
    type AddChildWorkflowRunResult,
    type Backend,
    type CancelWorkflowRunParams,
    type ClaimWorkflowRunParams,
    type CompleteStepAttemptParams,
    type CompleteWorkflowRunParams,
    type CreateStepAttemptParams,
    type CreateWorkflowRunParams,
    type ExtendWorkflowRunLeaseParams,
    type FailStepAttemptParams,
    type FailWorkflowRunParams,
    type GetSignalDeliveryParams,
    type GetStepAttemptParams,
    type GetWorkflowRunParams,
    type JsonValue,
    type ListStepAttemptsParams,
    type ListWorkflowRunsParams,
    type PaginatedResponse,
    type RescheduleWorkflowRunAfterFailedStepAttemptParams,
    type RetryPolicy,
    type SendSignalParams,
    type SendSignalResult,
    type SerializedError,
    type SetStepAttemptChildWorkflowRunParams,
    type SleepWorkflowRunParams,
    type StepAttempt,
    type WorkflowRun,
    type WorkflowRunCounts,
    type WorkflowRunStatus,
} from "../index";

type RunPredicate = (runs: readonly WorkflowRun[]) => boolean;

interface WorkflowRunWaiter {
    readonly predicate: RunPredicate;
    readonly resolve: () => void;
}

class InMemoryWorkflowBackend implements Backend {
    private readonly namespaceId = "test";
    private readonly workflowRunsById = new Map<string, WorkflowRun>();
    private readonly stepAttemptsById = new Map<string, StepAttempt>();
    private readonly runWaiters: WorkflowRunWaiter[] = [];
    private sequence = 0;

    workflowRuns(): WorkflowRun[] {
        return [...this.workflowRunsById.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
    }

    childWorkflowRuns(parentWorkflowRunId: string): WorkflowRun[] {
        const parentStepAttemptIds = new Set(
            [...this.stepAttemptsById.values()]
                .filter((attempt) => attempt.workflowRunId === parentWorkflowRunId && attempt.kind === "workflow")
                .map((attempt) => attempt.id)
        );
        return this.workflowRuns().filter((run) => run.parentStepAttemptId !== null && parentStepAttemptIds.has(run.parentStepAttemptId));
    }

    waitForWorkflowRuns(predicate: RunPredicate): Promise<void> {
        if (predicate(this.workflowRuns())) {
            return Promise.resolve();
        }

        const { promise, resolve } = Promise.withResolvers<void>();
        this.runWaiters.push({ predicate, resolve });
        return promise;
    }

    async createWorkflowRun(params: Readonly<CreateWorkflowRunParams>): Promise<WorkflowRun> {
        if (params.idempotencyKey !== null) {
            const existing = this.workflowRuns().find(
                (run) => run.workflowName === params.workflowName && run.idempotencyKey === params.idempotencyKey
            );
            if (existing) {
                return existing;
            }
        }

        const now = this.now();
        const workflowRun: WorkflowRun = {
            namespaceId: this.namespaceId,
            id: this.nextId("run"),
            workflowName: params.workflowName,
            version: params.version,
            status: "pending",
            idempotencyKey: params.idempotencyKey,
            config: params.config,
            context: params.context,
            input: params.input,
            output: null,
            error: null,
            attempts: 0,
            parentStepAttemptNamespaceId: params.parentStepAttemptNamespaceId,
            parentStepAttemptId: params.parentStepAttemptId,
            workerId: null,
            availableAt: params.availableAt ?? now,
            deadlineAt: params.deadlineAt,
            startedAt: null,
            finishedAt: null,
            createdAt: now,
            updatedAt: now,
        };
        this.workflowRunsById.set(workflowRun.id, workflowRun);
        this.notifyRunWaiters();
        return workflowRun;
    }

    async getWorkflowRun(params: Readonly<GetWorkflowRunParams>): Promise<WorkflowRun | null> {
        return this.workflowRunsById.get(params.workflowRunId) ?? null;
    }

    async listWorkflowRuns(params: Readonly<ListWorkflowRunsParams>): Promise<PaginatedResponse<WorkflowRun>> {
        return { data: this.workflowRuns().slice(0, params.limit ?? 100), pagination: { next: null, prev: null } };
    }

    async countWorkflowRuns(): Promise<WorkflowRunCounts> {
        const counts: WorkflowRunCounts = { pending: 0, running: 0, completed: 0, failed: 0, canceled: 0 };
        for (const run of this.workflowRunsById.values()) {
            if (run.status in counts) {
                counts[run.status as keyof WorkflowRunCounts] += 1;
            }
        }
        return counts;
    }

    async claimWorkflowRun(params: Readonly<ClaimWorkflowRunParams>): Promise<WorkflowRun | null> {
        const nowMs = Date.now();
        const candidate = this.workflowRuns()
            .filter(
                (run) =>
                    (run.status === "pending" || run.status === "running" || run.status === "sleeping") &&
                    (run.availableAt?.getTime() ?? nowMs) <= nowMs &&
                    (run.deadlineAt === null || run.deadlineAt.getTime() > nowMs) &&
                    !this.hasRunningFunctionStep(run.id)
            )
            .sort(
                (left, right) =>
                    statusClaimPriority(left.status) - statusClaimPriority(right.status) ||
                    (left.availableAt?.getTime() ?? 0) - (right.availableAt?.getTime() ?? 0) ||
                    left.createdAt.getTime() - right.createdAt.getTime() ||
                    left.id.localeCompare(right.id)
            )[0];

        if (!candidate) {
            return null;
        }

        return this.updateWorkflowRun(candidate.id, {
            status: "running",
            attempts: candidate.attempts + 1,
            workerId: params.workerId,
            availableAt: new Date(nowMs + params.leaseDurationMs),
            startedAt: candidate.startedAt ?? this.now(),
            updatedAt: this.now(),
        });
    }

    async extendWorkflowRunLease(params: Readonly<ExtendWorkflowRunLeaseParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        return this.updateWorkflowRun(run.id, { availableAt: new Date(Date.now() + params.leaseDurationMs), updatedAt: this.now() });
    }

    async sleepWorkflowRun(params: Readonly<SleepWorkflowRunParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        return this.updateWorkflowRun(run.id, {
            status: "running",
            workerId: null,
            availableAt: params.availableAt,
            updatedAt: this.now(),
        });
    }

    async completeWorkflowRun(params: Readonly<CompleteWorkflowRunParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const completed = this.updateWorkflowRun(run.id, {
            status: "completed",
            output: params.output,
            error: null,
            workerId: params.workerId,
            availableAt: null,
            finishedAt: this.now(),
            updatedAt: this.now(),
        });
        this.wakeParentWorkflowRun(completed);
        return completed;
    }

    async failWorkflowRun(params: Readonly<FailWorkflowRunParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const failure = workflowFailureUpdate(params.retryPolicy, params.error);
        const failed = this.updateWorkflowRun(run.id, {
            status: failure.status,
            error: failure.error,
            workerId: null,
            availableAt: failure.availableAt,
            finishedAt: failure.finishedAt,
            updatedAt: this.now(),
        });
        if (failed.status === "failed") {
            this.wakeParentWorkflowRun(failed);
        }
        return failed;
    }

    async rescheduleWorkflowRunAfterFailedStepAttempt(
        params: Readonly<RescheduleWorkflowRunAfterFailedStepAttemptParams>
    ): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        return this.updateWorkflowRun(run.id, {
            status: "pending",
            error: params.error,
            workerId: null,
            availableAt: params.availableAt,
            startedAt: null,
            updatedAt: this.now(),
        });
    }

    async cancelWorkflowRun(params: Readonly<CancelWorkflowRunParams>): Promise<WorkflowRun> {
        const run = this.requireWorkflowRun(params.workflowRunId);
        const canceled = this.updateWorkflowRun(run.id, {
            status: "canceled",
            workerId: null,
            availableAt: null,
            finishedAt: this.now(),
            updatedAt: this.now(),
        });
        this.wakeParentWorkflowRun(canceled);
        return canceled;
    }

    async createStepAttempt(params: Readonly<CreateStepAttemptParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const now = this.now();
        const attempt: StepAttempt = {
            namespaceId: this.namespaceId,
            id: this.nextId("step"),
            workflowRunId: params.workflowRunId,
            stepName: params.stepName,
            kind: params.kind,
            status: "running",
            config: params.config,
            context: params.context,
            output: null,
            error: null,
            childWorkflowRunNamespaceId: null,
            childWorkflowRunId: null,
            startedAt: now,
            finishedAt: null,
            createdAt: now,
            updatedAt: now,
        };
        this.stepAttemptsById.set(attempt.id, attempt);
        return attempt;
    }

    async getStepAttempt(params: Readonly<GetStepAttemptParams>): Promise<StepAttempt | null> {
        return this.stepAttemptsById.get(params.stepAttemptId) ?? null;
    }

    async listStepAttempts(params: Readonly<ListStepAttemptsParams>): Promise<PaginatedResponse<StepAttempt>> {
        const attempts = [...this.stepAttemptsById.values()]
            .filter((attempt) => attempt.workflowRunId === params.workflowRunId)
            .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
        return { data: attempts.slice(0, params.limit ?? 1000), pagination: { next: null, prev: null } };
    }

    async completeStepAttempt(params: Readonly<CompleteStepAttemptParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const attempt = this.requireRunningStepAttempt(params.workflowRunId, params.stepAttemptId);
        return this.updateStepAttempt(attempt.id, { status: "completed", output: params.output, error: null, finishedAt: this.now(), updatedAt: this.now() });
    }

    async failStepAttempt(params: Readonly<FailStepAttemptParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const attempt = this.requireRunningStepAttempt(params.workflowRunId, params.stepAttemptId);
        return this.updateStepAttempt(attempt.id, { status: "failed", output: null, error: params.error, finishedAt: this.now(), updatedAt: this.now() });
    }

    async setStepAttemptChildWorkflowRun(params: Readonly<SetStepAttemptChildWorkflowRunParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const attempt = this.requireRunningStepAttempt(params.workflowRunId, params.stepAttemptId);
        return this.updateStepAttempt(attempt.id, {
            childWorkflowRunNamespaceId: params.childWorkflowRunNamespaceId,
            childWorkflowRunId: params.childWorkflowRunId,
            updatedAt: this.now(),
        });
    }

    async sendSignal(params: Readonly<SendSignalParams>): Promise<SendSignalResult> {
        return { workflowRunIds: [] };
    }

    async getSignalDelivery(params: Readonly<GetSignalDeliveryParams>): Promise<JsonValue | undefined> {
        return undefined;
    }

    async addChildWorkflowRun<Input>(params: Readonly<{ parentWorkflowRunId: string; stepName: string; workflowName: string; version: string | null; input: Input }>): Promise<AddChildWorkflowRunResult> {
        const parent = this.requireWorkflowRun(params.parentWorkflowRunId);
        const attempt = await this.createStepAttempt({
            workflowRunId: parent.id,
            workerId: parent.workerId ?? "",
            stepName: params.stepName,
            kind: "workflow",
            config: { external: true },
            context: { kind: "workflow", timeoutAt: null },
        });
        const workflowRun = await this.createWorkflowRun({
            workflowName: params.workflowName,
            version: params.version,
            idempotencyKey: `external:${parent.id}:${params.stepName}`,
            config: {},
            context: null,
            input: params.input as JsonValue,
            parentStepAttemptNamespaceId: attempt.namespaceId,
            parentStepAttemptId: attempt.id,
            availableAt: null,
            deadlineAt: null,
        });
        const stepAttempt = await this.setStepAttemptChildWorkflowRun({
            workflowRunId: parent.id,
            stepAttemptId: attempt.id,
            workerId: parent.workerId ?? "",
            childWorkflowRunNamespaceId: workflowRun.namespaceId,
            childWorkflowRunId: workflowRun.id,
        });
        return { stepAttempt, workflowRun };
    }

    async stop(): Promise<void> {}

    private nextId(prefix: string): string {
        this.sequence += 1;
        return `${prefix}-${this.sequence}`;
    }

    private now(): Date {
        return new Date();
    }

    private hasRunningFunctionStep(workflowRunId: string): boolean {
        return [...this.stepAttemptsById.values()].some(
            (attempt) => attempt.workflowRunId === workflowRunId && attempt.kind === "function" && attempt.status === "running"
        );
    }

    private requireWorkflowRun(workflowRunId: string): WorkflowRun {
        const run = this.workflowRunsById.get(workflowRunId);
        if (!run) {
            throw new Error(`Workflow run ${workflowRunId} does not exist`);
        }
        return run;
    }

    private requireOwnedRunningWorkflowRun(workflowRunId: string, workerId: string): WorkflowRun {
        const run = this.requireWorkflowRun(workflowRunId);
        if (run.status !== "running" || run.workerId !== workerId) {
            throw new Error("Workflow run is not owned by worker");
        }
        return run;
    }

    private requireRunningStepAttempt(workflowRunId: string, stepAttemptId: string): StepAttempt {
        const attempt = this.stepAttemptsById.get(stepAttemptId);
        if (!attempt || attempt.workflowRunId !== workflowRunId || attempt.status !== "running") {
            throw new Error("Step attempt is not running");
        }
        return attempt;
    }

    private updateWorkflowRun(workflowRunId: string, patch: Partial<WorkflowRun>): WorkflowRun {
        const current = this.requireWorkflowRun(workflowRunId);
        const updated: WorkflowRun = { ...current, ...patch };
        this.workflowRunsById.set(workflowRunId, updated);
        this.notifyRunWaiters();
        return updated;
    }

    private updateStepAttempt(stepAttemptId: string, patch: Partial<StepAttempt>): StepAttempt {
        const current = this.stepAttemptsById.get(stepAttemptId);
        if (!current) {
            throw new Error(`Step attempt ${stepAttemptId} does not exist`);
        }
        const updated: StepAttempt = { ...current, ...patch };
        this.stepAttemptsById.set(stepAttemptId, updated);
        return updated;
    }

    private wakeParentWorkflowRun(childWorkflowRun: WorkflowRun): void {
        if (!childWorkflowRun.parentStepAttemptId) {
            return;
        }
        const parentAttempt = this.stepAttemptsById.get(childWorkflowRun.parentStepAttemptId);
        if (!parentAttempt || parentAttempt.status !== "running") {
            return;
        }
        const parentRun = this.workflowRunsById.get(parentAttempt.workflowRunId);
        if (!parentRun || parentRun.workerId !== null || (parentRun.status !== "running" && parentRun.status !== "sleeping")) {
            return;
        }
        const now = this.now();
        const availableAt = parentRun.availableAt === null || parentRun.availableAt.getTime() > now.getTime() ? now : parentRun.availableAt;
        this.updateWorkflowRun(parentRun.id, { availableAt, updatedAt: now });
    }

    private notifyRunWaiters(): void {
        for (const waiter of [...this.runWaiters]) {
            if (!waiter.predicate(this.workflowRuns())) {
                continue;
            }
            const index = this.runWaiters.indexOf(waiter);
            if (index >= 0) {
                this.runWaiters.splice(index, 1);
            }
            waiter.resolve();
        }
    }
}

function statusClaimPriority(status: WorkflowRunStatus): number {
    return status === "pending" ? 0 : 1;
}

function workflowFailureUpdate(retryPolicy: RetryPolicy, error: SerializedError): { status: "pending" | "failed"; error: SerializedError; availableAt: Date | null; finishedAt: Date | null } {
    if (retryPolicy.maximumAttempts === 0) {
        return { status: "pending", error, availableAt: new Date(), finishedAt: null };
    }
    return { status: "failed", error, availableAt: null, finishedAt: new Date() };
}

async function flushRuntimeMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function runReadyWorkflow(worker: { tick(): Promise<number> }): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const claimed = await worker.tick();
        if (claimed === 1) {
            await flushRuntimeMicrotasks();
            return;
        }
        await flushRuntimeMicrotasks();
    }
    expect(await worker.tick()).toBe(1);
    await flushRuntimeMicrotasks();
}

describe("workflow runtime worker parking", () => {
    test("parks a workflow waiting on step.sleep so the same worker can claim another pending run", async () => {
        const backend = new InMemoryWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const sleeper = client.defineWorkflow({ name: "sleep-parking-run" }, async ({ step }) => {
            await step.sleep("park", "1h");
            return "woke";
        });
        const marker = client.defineWorkflow({ name: "same-worker-marker" }, () => "claimed-after-park");
        const worker = client.newWorker();

        const sleeperHandle = await sleeper.run();
        const markerHandle = await marker.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === sleeperHandle.workflowRun.id && run.workerId === null));
        await flushRuntimeMicrotasks();

        const parkedSleeper = await backend.getWorkflowRun({ workflowRunId: sleeperHandle.workflowRun.id });
        expect(parkedSleeper?.status).toBe("running");
        expect(parkedSleeper?.workerId).toBeNull();
        expect(parkedSleeper?.output).toBeNull();
        expect(parkedSleeper?.availableAt?.getTime()).toBeGreaterThan(Date.now());

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === markerHandle.workflowRun.id && run.status === "completed"));

        const completedMarker = await backend.getWorkflowRun({ workflowRunId: markerHandle.workflowRun.id });
        expect(completedMarker?.output).toBe("claimed-after-park");
        const stillParkedSleeper = await backend.getWorkflowRun({ workflowRunId: sleeperHandle.workflowRun.id });
        expect(stillParkedSleeper?.status).toBe("running");
        expect(stillParkedSleeper?.workerId).toBeNull();
    });
});

describe("workflow runtime child fan-out", () => {
    test("completes a parent after Promise.all child workflow outputs are available", async () => {
        const backend = new InMemoryWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const child = client.defineWorkflow<number, number>({ name: "all-child" }, ({ input }) => input * 10);
        const parent = client.defineWorkflow({ name: "all-parent" }, async ({ step }) => {
            return await Promise.all([
                step.runWorkflow(child.workflow.spec, 1, { name: "first-child" }),
                step.runWorkflow(child.workflow.spec, 2, { name: "second-child" }),
                step.runWorkflow(child.workflow.spec, 3, { name: "third-child" }),
            ]);
        });
        const worker = client.newWorker();

        const parentHandle = await parent.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns(() => backend.childWorkflowRuns(parentHandle.workflowRun.id).length === 3);
        await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === parentHandle.workflowRun.id && run.workerId === null));
        await flushRuntimeMicrotasks();

        const parkedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(parkedParent?.workerId).toBeNull();
        expect(parkedParent?.output).toBeNull();

        for (const childRun of backend.childWorkflowRuns(parentHandle.workflowRun.id)) {
            await runReadyWorkflow(worker);
            await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === childRun.id && run.status === "completed"));
        }

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === parentHandle.workflowRun.id && run.status === "completed"));

        const completedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(completedParent?.output).toEqual([10, 20, 30]);
    });

    test("completes a parent after Promise.allSettled observes fulfilled child workflow outputs", async () => {
        const backend = new InMemoryWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const child = client.defineWorkflow<number, number>({ name: "settled-child" }, ({ input }) => input + 100);
        const parent = client.defineWorkflow({ name: "settled-parent" }, async ({ step }) => {
            const settled = await Promise.allSettled([
                step.runWorkflow(child.workflow.spec, 4, { name: "fourth-child" }),
                step.runWorkflow(child.workflow.spec, 5, { name: "fifth-child" }),
                step.runWorkflow(child.workflow.spec, 6, { name: "sixth-child" }),
            ]);
            return settled.map((result) =>
                result.status === "fulfilled" ? { status: result.status, value: result.value } : { status: result.status }
            );
        });
        const worker = client.newWorker();

        const parentHandle = await parent.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns(() => backend.childWorkflowRuns(parentHandle.workflowRun.id).length === 3);
        await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === parentHandle.workflowRun.id && run.workerId === null));
        await flushRuntimeMicrotasks();

        const parkedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(parkedParent?.workerId).toBeNull();
        expect(parkedParent?.output).toBeNull();

        for (const childRun of backend.childWorkflowRuns(parentHandle.workflowRun.id)) {
            await runReadyWorkflow(worker);
            await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === childRun.id && run.status === "completed"));
        }

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) => runs.some((run) => run.id === parentHandle.workflowRun.id && run.status === "completed"));

        const completedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(completedParent?.output).toEqual([
            { status: "fulfilled", value: 104 },
            { status: "fulfilled", value: 105 },
            { status: "fulfilled", value: 106 },
        ]);
    });
});
