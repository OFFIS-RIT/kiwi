import { describe, expect, test } from "bun:test";

import {
    WorkflowClient,
    deserializeError,
    serializeError,
    type AddChildWorkflowRunParams,
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
    type StandardSchemaV1,
    type StepAttempt,
    type WorkflowLogger,
    type WorkflowRun,
    type WorkflowRunCounts,
    type WorkflowRunStatus,
} from "../index";

type RunPredicate = (runs: readonly WorkflowRun[]) => boolean;

interface WorkflowRunWaiter {
    readonly predicate: RunPredicate;
    readonly resolve: () => void;
}

interface CursorPage<T extends { readonly id: string }> {
    readonly data: T[];
    readonly next: string | null;
    readonly prev: string | null;
}

class ContractTestWorkflowBackend implements Backend {
    private readonly namespaceId = "test";
    private readonly workflowRunsById = new Map<string, WorkflowRun>();
    private readonly stepAttemptsById = new Map<string, StepAttempt>();
    private readonly signalDeliveriesByStepAttemptId = new Map<string, JsonValue | null>();
    private readonly signalResultsByIdempotencyKey = new Map<string, SendSignalResult>();
    private readonly runWaiters: WorkflowRunWaiter[] = [];
    private sequence = 0;
    signalSendCallCount = 0;
    failNextChildLink = false;

    workflowRuns(): WorkflowRun[] {
        return [...this.workflowRunsById.values()].sort(
            (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
        );
    }

    stepAttempts(workflowRunId: string): StepAttempt[] {
        return [...this.stepAttemptsById.values()]
            .filter((attempt) => attempt.workflowRunId === workflowRunId)
            .sort(
                (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
            );
    }

    childWorkflowRuns(parentWorkflowRunId: string): WorkflowRun[] {
        const parentStepAttemptIds = new Set(
            this.stepAttempts(parentWorkflowRunId)
                .filter((attempt) => attempt.kind === "workflow")
                .map((attempt) => attempt.id)
        );
        return this.workflowRuns().filter(
            (run) => run.parentStepAttemptId !== null && parentStepAttemptIds.has(run.parentStepAttemptId)
        );
    }

    waitForWorkflowRuns(predicate: RunPredicate): Promise<void> {
        if (predicate(this.workflowRuns())) {
            return Promise.resolve();
        }

        const { promise, resolve } = Promise.withResolvers<void>();
        this.runWaiters.push({ predicate, resolve });
        return promise;
    }

    async startWorkflowRun(params: Readonly<Omit<CreateWorkflowRunParams, "parentStepAttemptNamespaceId" | "parentStepAttemptId">>): Promise<WorkflowRun> {
        return this.createWorkflowRun({
            ...params,
            parentStepAttemptNamespaceId: null,
            parentStepAttemptId: null,
        });
    }

    async claimNextRunnableWorkflow(params: Readonly<ClaimWorkflowRunParams>): Promise<WorkflowRun | null> {
        return this.claimWorkflowRun(params);
    }

    async heartbeatClaim(params: Readonly<ExtendWorkflowRunLeaseParams>): Promise<WorkflowRun> {
        return this.extendWorkflowRunLease(params);
    }

    async parkClaimedWorkflow(params: Readonly<SleepWorkflowRunParams>): Promise<WorkflowRun> {
        return this.sleepWorkflowRun(params);
    }

    async completeClaimedWorkflow(params: Readonly<CompleteWorkflowRunParams>): Promise<WorkflowRun> {
        return this.completeWorkflowRun(params);
    }

    async failClaimedWorkflow(params: Readonly<FailWorkflowRunParams>): Promise<WorkflowRun> {
        return this.failWorkflowRun(params);
    }

    async rescheduleClaimedWorkflowAfterStepFailure(
        params: Readonly<RescheduleWorkflowRunAfterFailedStepAttemptParams>
    ): Promise<WorkflowRun> {
        return this.rescheduleWorkflowRunAfterFailedStepAttempt(params);
    }

    async startStepAttempt(params: Readonly<CreateStepAttemptParams>): Promise<StepAttempt> {
        return this.createStepAttempt(params);
    }

    async recordStepAttemptResult(
        params: Readonly<
            | (CompleteStepAttemptParams & { readonly status: "completed" })
            | (FailStepAttemptParams & { readonly status: "failed" })
        >
    ): Promise<StepAttempt> {
        return params.status === "completed" ? this.completeStepAttempt(params) : this.failStepAttempt(params);
    }

    async startChildWorkflow<Input>(
        params: Readonly<{
            parentWorkflowRunId: string;
            stepName: string;
            workflowName: string;
            version: string | null;
            input: Input;
            config?: JsonValue;
            timeoutAt?: Date | null;
            idempotencyKey?: string;
            workerId?: string;
            stepAttemptId?: string;
        }>
    ): Promise<AddChildWorkflowRunResult> {
        if (params.stepAttemptId && params.workerId) {
            const workflowRun = await this.createWorkflowRun({
                workflowName: params.workflowName,
                version: params.version,
                idempotencyKey: params.idempotencyKey ?? null,
                config: params.config ?? {},
                context: null,
                input: params.input as JsonValue,
                parentStepAttemptNamespaceId: this.namespaceId,
                parentStepAttemptId: params.stepAttemptId,
                availableAt: null,
                deadlineAt: params.timeoutAt ?? null,
            });
            const stepAttempt = await this.setStepAttemptChildWorkflowRun({
                workflowRunId: params.parentWorkflowRunId,
                stepAttemptId: params.stepAttemptId,
                workerId: params.workerId,
                childWorkflowRunNamespaceId: workflowRun.namespaceId,
                childWorkflowRunId: workflowRun.id,
            });
            return { stepAttempt, workflowRun };
        }

        return this.addChildWorkflowRun(params);
    }

    async deliverSignal(params: Readonly<SendSignalParams>): Promise<SendSignalResult> {
        return this.sendSignal(params);
    }

    async awaitSignal(params: Readonly<GetSignalDeliveryParams>): Promise<JsonValue | undefined> {
        return this.getSignalDelivery(params);
    }

    private async createWorkflowRun(params: Readonly<CreateWorkflowRunParams>): Promise<WorkflowRun> {
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
        return toPaginatedResponse(this.workflowRuns(), params.limit ?? 100, params.after, params.before);
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

    private async claimWorkflowRun(params: Readonly<ClaimWorkflowRunParams>): Promise<WorkflowRun | null> {
        const nowMs = Date.now();
        const candidate = this.workflowRuns()
            .filter(
                (run) =>
                    (run.status === "pending" || run.status === "running" || run.status === "sleeping") &&
                    (run.availableAt?.getTime() ?? nowMs) <= nowMs &&
                    (run.deadlineAt === null || run.deadlineAt.getTime() > nowMs)
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

    private async extendWorkflowRunLease(params: Readonly<ExtendWorkflowRunLeaseParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        return this.updateWorkflowRun(run.id, {
            availableAt: new Date(Date.now() + params.leaseDurationMs),
            updatedAt: this.now(),
        });
    }

    private async sleepWorkflowRun(params: Readonly<SleepWorkflowRunParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        return this.updateWorkflowRun(run.id, {
            status: "running",
            workerId: null,
            availableAt: params.availableAt,
            updatedAt: this.now(),
        });
    }

    private async completeWorkflowRun(params: Readonly<CompleteWorkflowRunParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const completed = this.updateWorkflowRun(run.id, {
            status: "completed",
            output: params.output,
            error: null,
            workerId: null,
            availableAt: null,
            finishedAt: this.now(),
            updatedAt: this.now(),
        });
        this.wakeParentWorkflowRun(completed);
        return completed;
    }

    private async failWorkflowRun(params: Readonly<FailWorkflowRunParams>): Promise<WorkflowRun> {
        const run = this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const failure = workflowFailureUpdate(
            params.retryPolicy,
            params.attempts ?? run.attempts,
            params.deadlineAt ?? run.deadlineAt,
            params.error
        );
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

    private async rescheduleWorkflowRunAfterFailedStepAttempt(
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

    private async createStepAttempt(params: Readonly<CreateStepAttemptParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        return this.createStepAttemptUnchecked(
            params.workflowRunId,
            params.stepName,
            params.kind,
            params.config,
            params.context
        );
    }

    private async getStepAttempt(params: Readonly<GetStepAttemptParams>): Promise<StepAttempt | null> {
        return this.stepAttemptsById.get(params.stepAttemptId) ?? null;
    }

    async listStepAttempts(params: Readonly<ListStepAttemptsParams>): Promise<PaginatedResponse<StepAttempt>> {
        return toPaginatedResponse(
            this.stepAttempts(params.workflowRunId),
            params.limit ?? 1000,
            params.after,
            params.before
        );
    }

    private async completeStepAttempt(params: Readonly<CompleteStepAttemptParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const attempt = this.requireRunningStepAttempt(params.workflowRunId, params.stepAttemptId);
        return this.updateStepAttempt(attempt.id, {
            status: "completed",
            output: params.output,
            error: null,
            finishedAt: this.now(),
            updatedAt: this.now(),
        });
    }

    private async failStepAttempt(params: Readonly<FailStepAttemptParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const attempt = this.requireRunningStepAttempt(params.workflowRunId, params.stepAttemptId);
        return this.updateStepAttempt(attempt.id, {
            status: "failed",
            output: null,
            error: params.error,
            finishedAt: this.now(),
            updatedAt: this.now(),
        });
    }

    private async setStepAttemptChildWorkflowRun(params: Readonly<SetStepAttemptChildWorkflowRunParams>): Promise<StepAttempt> {
        this.requireOwnedRunningWorkflowRun(params.workflowRunId, params.workerId);
        const attempt = this.requireRunningStepAttempt(params.workflowRunId, params.stepAttemptId);
        if (this.failNextChildLink) {
            this.failNextChildLink = false;
            throw new Error("Simulated crash after child workflow creation");
        }
        return this.updateStepAttempt(attempt.id, {
            childWorkflowRunNamespaceId: params.childWorkflowRunNamespaceId,
            childWorkflowRunId: params.childWorkflowRunId,
            updatedAt: this.now(),
        });
    }

    private async sendSignal(params: Readonly<SendSignalParams>): Promise<SendSignalResult> {
        if (params.idempotencyKey !== null) {
            const existing = this.signalResultsByIdempotencyKey.get(params.idempotencyKey);
            if (existing) {
                return existing;
            }
        }

        this.signalSendCallCount += 1;

        const workflowRunIds: string[] = [];
        for (const attempt of this.stepAttemptsById.values()) {
            if (
                attempt.status !== "running" ||
                attempt.kind !== "signal-wait" ||
                attempt.context?.kind !== "signal-wait"
            ) {
                continue;
            }
            if (attempt.context.signal !== params.signal || this.signalDeliveriesByStepAttemptId.has(attempt.id)) {
                continue;
            }
            this.signalDeliveriesByStepAttemptId.set(attempt.id, params.data);
            workflowRunIds.push(attempt.workflowRunId);
            this.wakeWorkflowRun(attempt.workflowRunId);
        }

        const result = { workflowRunIds };
        if (params.idempotencyKey !== null) {
            this.signalResultsByIdempotencyKey.set(params.idempotencyKey, result);
        }
        return result;
    }

    private async getSignalDelivery(params: Readonly<GetSignalDeliveryParams>): Promise<JsonValue | undefined> {
        return this.signalDeliveriesByStepAttemptId.has(params.stepAttemptId)
            ? (this.signalDeliveriesByStepAttemptId.get(params.stepAttemptId) ?? null)
            : undefined;
    }

    private async addChildWorkflowRun<Input>(
        params: Readonly<AddChildWorkflowRunParams<Input>>
    ): Promise<AddChildWorkflowRunResult> {
        const parent = this.requireWorkflowRun(params.parentWorkflowRunId);
        if (parent.status !== "running" && parent.status !== "sleeping") {
            throw new Error("Parent workflow run is not active");
        }

        const idempotencyKey =
            params.idempotencyKey ??
            `__external_child:${this.namespaceId}:${params.parentWorkflowRunId}:${params.stepName}`;
        const existing = this.workflowRuns().find(
            (run) =>
                run.workflowName === params.workflowName &&
                run.idempotencyKey === idempotencyKey &&
                run.parentStepAttemptNamespaceId === this.namespaceId
        );
        if (existing?.parentStepAttemptId) {
            const existingAttempt = this.requireStepAttempt(existing.parentStepAttemptId);
            return { stepAttempt: existingAttempt, workflowRun: existing };
        }

        const baseConfig =
            params.config && typeof params.config === "object" && !Array.isArray(params.config) ? params.config : {};
        const attempt = this.createStepAttemptUnchecked(
            parent.id,
            params.stepName,
            "workflow",
            { ...baseConfig, external: true, idempotencyKey },
            { kind: "workflow", timeoutAt: params.timeoutAt?.toISOString() ?? null }
        );
        const workflowRun = await this.createWorkflowRun({
            workflowName: params.workflowName,
            version: params.version,
            idempotencyKey,
            config: {},
            context: null,
            input: params.input as JsonValue,
            parentStepAttemptNamespaceId: attempt.namespaceId,
            parentStepAttemptId: attempt.id,
            availableAt: null,
            deadlineAt: null,
        });
        const stepAttempt = this.updateStepAttempt(attempt.id, {
            childWorkflowRunNamespaceId: workflowRun.namespaceId,
            childWorkflowRunId: workflowRun.id,
            updatedAt: this.now(),
        });
        this.wakeWorkflowRun(parent.id);
        return { stepAttempt, workflowRun };
    }

    async stop(): Promise<void> {}

    private createStepAttemptUnchecked(
        workflowRunId: string,
        stepName: string,
        kind: StepAttempt["kind"],
        config: JsonValue,
        context: StepAttempt["context"]
    ): StepAttempt {
        const now = this.now();
        const attempt: StepAttempt = {
            namespaceId: this.namespaceId,
            id: this.nextId("step"),
            workflowRunId,
            stepName,
            kind,
            status: "running",
            config,
            context,
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

    private nextId(prefix: string): string {
        this.sequence += 1;
        return `${prefix}-${this.sequence}`;
    }

    private now(): Date {
        return new Date();
    }

    private hasRunningFunctionStep(workflowRunId: string): boolean {
        return [...this.stepAttemptsById.values()].some(
            (attempt) =>
                attempt.workflowRunId === workflowRunId && attempt.kind === "function" && attempt.status === "running"
        );
    }

    private requireWorkflowRun(workflowRunId: string): WorkflowRun {
        const run = this.workflowRunsById.get(workflowRunId);
        if (!run) {
            throw new Error(`Workflow run ${workflowRunId} does not exist`);
        }
        return run;
    }

    private requireStepAttempt(stepAttemptId: string): StepAttempt {
        const attempt = this.stepAttemptsById.get(stepAttemptId);
        if (!attempt) {
            throw new Error(`Step attempt ${stepAttemptId} does not exist`);
        }
        return attempt;
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
        const current = this.requireStepAttempt(stepAttemptId);
        const updated: StepAttempt = { ...current, ...patch };
        this.stepAttemptsById.set(stepAttemptId, updated);
        return updated;
    }

    private wakeWorkflowRun(workflowRunId: string): void {
        const run = this.workflowRunsById.get(workflowRunId);
        if (!run || run.workerId !== null || (run.status !== "running" && run.status !== "sleeping")) {
            return;
        }
        const now = this.now();
        const availableAt =
            run.availableAt === null || run.availableAt.getTime() > now.getTime() ? now : run.availableAt;
        this.updateWorkflowRun(run.id, { availableAt, updatedAt: now });
    }

    private wakeParentWorkflowRun(childWorkflowRun: WorkflowRun): void {
        const parentAttempt = [...this.stepAttemptsById.values()].find(
            (attempt) =>
                attempt.kind === "workflow" &&
                attempt.status === "running" &&
                attempt.childWorkflowRunNamespaceId === childWorkflowRun.namespaceId &&
                attempt.childWorkflowRunId === childWorkflowRun.id
        );
        if (!parentAttempt) {
            return;
        }
        this.wakeWorkflowRun(parentAttempt.workflowRunId);
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

function workflowFailureUpdate(
    retryPolicy: RetryPolicy,
    attempts: number,
    deadlineAt: Date | null,
    error: SerializedError
): { status: "pending" | "failed"; error: SerializedError; availableAt: Date | null; finishedAt: Date | null } {
    const now = new Date();
    if (deadlineAt && now >= deadlineAt) {
        return {
            status: "failed",
            error: { message: "Workflow run deadline exceeded" },
            availableAt: null,
            finishedAt: now,
        };
    }
    if (retryPolicy.maximumAttempts > 0 && attempts >= retryPolicy.maximumAttempts) {
        return { status: "failed", error, availableAt: null, finishedAt: now };
    }
    return { status: "pending", error, availableAt: now, finishedAt: null };
}

function toPaginatedResponse<T extends { readonly id: string }>(
    items: readonly T[],
    limit: number,
    after?: string,
    before?: string
): PaginatedResponse<T> {
    const page = cursorPage(items, Math.max(1, limit), after, before);
    return { data: page.data, pagination: { next: page.next, prev: page.prev } };
}

function cursorPage<T extends { readonly id: string }>(
    items: readonly T[],
    limit: number,
    after?: string,
    before?: string
): CursorPage<T> {
    let start = 0;
    let end = items.length;
    if (after) {
        const index = items.findIndex((item) => item.id === after);
        start = index >= 0 ? index + 1 : items.length;
    }
    if (before) {
        const index = items.findIndex((item) => item.id === before);
        end = index >= 0 ? index : 0;
    }

    const window = items.slice(start, end);
    const data = window.slice(0, limit);
    const firstIndex = data.length > 0 ? start : -1;
    const lastIndex = data.length > 0 ? start + data.length - 1 : -1;
    return {
        data,
        next: lastIndex >= 0 && lastIndex < end - 1 ? data[data.length - 1]!.id : null,
        prev: firstIndex > 0 ? data[0]!.id : null,
    };
}

function positiveNumberSchema(): StandardSchemaV1<unknown, number> {
    return {
        "~standard": {
            version: 1,
            vendor: "contract-test",
            validate: (input) =>
                typeof input === "number" && input > 0
                    ? { value: input }
                    : { issues: [{ message: "Expected a positive number" }] },
        },
    };
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

function withStackOrigin(error: Error, origin: string): Error {
    error.stack = `${error.stack ?? `${error.name}: ${error.message}`}\n    at ${origin}`;
    return error;
}

interface LoggedWorkflowError {
    readonly message: string;
    readonly fields?: Record<string, unknown>;
}

function createRecordingLogger(): WorkflowLogger & { readonly errors: LoggedWorkflowError[] } {
    const errors: LoggedWorkflowError[] = [];
    return {
        errors,
        error(message, fields) {
            errors.push({ message, fields });
        },
    };
}

function expectSingleLoggedWorkflowError(
    logger: Readonly<{ readonly errors: readonly LoggedWorkflowError[] }>,
    message: string
): Record<string, unknown> {
    expect(logger.errors).toHaveLength(1);
    const [logged] = logger.errors;
    expect(logged?.message).toBe(message);
    if (!logged?.fields) {
        throw new Error("Expected workflow logger call to include fields");
    }
    return logged.fields;
}

function expectSerializedErrorChain(
    serializedError: unknown,
    expected: Readonly<{
        message: string;
        stackOrigin: string;
        causeMessage: string;
        causeStackOrigin: string;
    }>
): void {
    const serialized = serializedError as SerializedError;
    expect(serialized.message).toBe(expected.message);
    expect(serialized.stack).toContain(expected.stackOrigin);
    expect(serialized.cause?.message).toBe(expected.causeMessage);
    expect(serialized.cause?.stack).toContain(expected.causeStackOrigin);
}

class ContractTaggedError extends Error {
    readonly _tag = "ContractTaggedError";
    readonly capability = "text";
    readonly operation = "generate-description";
    readonly code = "MODEL_NOT_CONFIGURED";
    readonly details = { requestId: "request-1", attempts: [1, 2], retryable: false };
    readonly recover = () => "skip";
    readonly binary = new Uint8Array([1, 2, 3]);

    constructor() {
        super("tagged contract failure");
        this.name = "ContractTaggedError";
    }
}

function createSerializedErrorChain(): Error {
    const root = withStackOrigin(new Error("serialized root cause"), "SERIALIZED_ROOT_ORIGIN");
    const middle = withStackOrigin(new Error("serialized middle cause", { cause: root }), "SERIALIZED_MIDDLE_ORIGIN");
    return withStackOrigin(new Error("serialized outer failure", { cause: middle }), "SERIALIZED_OUTER_ORIGIN");
}

function throwWorkflowVisibleFailure(): never {
    const root = withStackOrigin(new Error("workflow root cause"), "WORKFLOW_ROOT_ORIGIN");
    const error = withStackOrigin(
        new Error("workflow visible failure", { cause: root }),
        "WORKFLOW_ORIGINAL_THROW_ORIGIN"
    );
    throw error;
}

function throwStepVisibleFailure(): never {
    const root = withStackOrigin(new Error("step root cause"), "STEP_ROOT_ORIGIN");
    const error = withStackOrigin(new Error("step visible failure", { cause: root }), "STEP_ORIGINAL_THROW_ORIGIN");
    throw error;
}

describe("workflow runtime contracts", () => {
    test("serializes and deserializes nested Error causes with their original stacks", () => {
        const serialized = serializeError(createSerializedErrorChain());

        expect(serialized.message).toBe("serialized outer failure");
        expect(serialized.stack).toContain("SERIALIZED_OUTER_ORIGIN");
        expect(serialized.cause?.message).toBe("serialized middle cause");
        expect(serialized.cause?.stack).toContain("SERIALIZED_MIDDLE_ORIGIN");
        expect(serialized.cause?.cause?.message).toBe("serialized root cause");
        expect(serialized.cause?.cause?.stack).toContain("SERIALIZED_ROOT_ORIGIN");

        const deserialized = deserializeError(serialized);
        expect(deserialized.message).toBe("serialized outer failure");
        expect(deserialized.stack).toContain("SERIALIZED_OUTER_ORIGIN");
        expect(deserialized.cause).toBeInstanceOf(Error);
        const middle = deserialized.cause;
        if (!(middle instanceof Error)) {
            throw new Error("Expected deserialized middle cause to be an Error");
        }
        expect(middle.message).toBe("serialized middle cause");
        expect(middle.stack).toContain("SERIALIZED_MIDDLE_ORIGIN");
        expect(middle.cause).toBeInstanceOf(Error);
        const root = middle.cause;
        if (!(root instanceof Error)) {
            throw new Error("Expected deserialized root cause to be an Error");
        }
        expect(root.message).toBe("serialized root cause");
        expect(root.stack).toContain("SERIALIZED_ROOT_ORIGIN");
    });

    test("serializes tagged Error own JSON-safe fields and skips unsafe fields", () => {
        const serialized = serializeError(new ContractTaggedError());

        expect(serialized).toMatchObject({
            name: "ContractTaggedError",
            message: "tagged contract failure",
            _tag: "ContractTaggedError",
            capability: "text",
            operation: "generate-description",
            code: "MODEL_NOT_CONFIGURED",
            details: { requestId: "request-1", attempts: [1, 2], retryable: false },
        });
        expect("recover" in serialized).toBe(false);
        expect("binary" in serialized).toBe(false);
    });

    test("persists and logs the original caught-and-rethrown workflow error stack and cause", async () => {
        const backend = new ContractTestWorkflowBackend();
        const logger = createRecordingLogger();
        const client = new WorkflowClient({ backend, logger });
        let originalError: unknown;
        const workflow = client.defineWorkflow(
            { name: "caught-rethrown-workflow-error", retryPolicy: { maximumAttempts: 1 } },
            () => {
                try {
                    throwWorkflowVisibleFailure();
                } catch (error) {
                    originalError = error;
                    throw error;
                }
            }
        );
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "failed")
        );
        await flushRuntimeMicrotasks();

        const failed = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
        expect(failed?.error?.message).toBe("workflow visible failure");
        expect(failed?.error?.stack).toContain("WORKFLOW_ORIGINAL_THROW_ORIGIN");
        expect(failed?.error?.cause?.message).toBe("workflow root cause");
        expect(failed?.error?.cause?.stack).toContain("WORKFLOW_ROOT_ORIGIN");
        const fields = expectSingleLoggedWorkflowError(logger, "workflow run failed");
        expect(fields.workflowRunId).toBe(handle.workflowRun.id);
        expect(fields.workflowName).toBe("caught-rethrown-workflow-error");
        expect(fields.error).toBe(originalError);
        expectSerializedErrorChain(fields.serializedError, {
            message: "workflow visible failure",
            stackOrigin: "WORKFLOW_ORIGINAL_THROW_ORIGIN",
            causeMessage: "workflow root cause",
            causeStackOrigin: "WORKFLOW_ROOT_ORIGIN",
        });
    });

    test("persists and logs a retryable step failure when rescheduling the workflow", async () => {
        const backend = new ContractTestWorkflowBackend();
        const logger = createRecordingLogger();
        const client = new WorkflowClient({ backend, logger });
        let originalError: unknown;
        const workflow = client.defineWorkflow(
            { name: "retryable-step-logger", retryPolicy: { maximumAttempts: 1 } },
            async ({ step }) => {
                return await step.run(
                    {
                        name: "retryable-step",
                        retryPolicy: {
                            initialInterval: "0ms",
                            maximumInterval: "0ms",
                            backoffCoefficient: 1,
                            maximumAttempts: 2,
                        },
                    },
                    () => {
                        try {
                            throwStepVisibleFailure();
                        } catch (error) {
                            originalError = error;
                            throw error;
                        }
                    }
                );
            }
        );
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "pending")
        );
        await flushRuntimeMicrotasks();

        const rescheduled = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
        const [attempt] = backend.stepAttempts(handle.workflowRun.id);
        expect(rescheduled?.status).toBe("pending");
        expectSerializedErrorChain(rescheduled?.error, {
            message: "step visible failure",
            stackOrigin: "STEP_ORIGINAL_THROW_ORIGIN",
            causeMessage: "step root cause",
            causeStackOrigin: "STEP_ROOT_ORIGIN",
        });
        expect(attempt?.status).toBe("failed");
        expectSerializedErrorChain(attempt?.error, {
            message: "step visible failure",
            stackOrigin: "STEP_ORIGINAL_THROW_ORIGIN",
            causeMessage: "step root cause",
            causeStackOrigin: "STEP_ROOT_ORIGIN",
        });

        const fields = expectSingleLoggedWorkflowError(logger, "workflow run rescheduled after step failure");
        expect(fields.workflowRunId).toBe(handle.workflowRun.id);
        expect(fields.workflowName).toBe("retryable-step-logger");
        expect(fields.stepName).toBe("retryable-step");
        expect(fields.retryAttempt).toBe(1);
        expect(fields.retryMaxAttempts).toBe(2);
        expect(fields.error).toBe(originalError);
        expectSerializedErrorChain(fields.serializedError, {
            message: "step visible failure",
            stackOrigin: "STEP_ORIGINAL_THROW_ORIGIN",
            causeMessage: "step root cause",
            causeStackOrigin: "STEP_ROOT_ORIGIN",
        });
    });

    test("records the original caught-and-rethrown step error stack and cause on terminal failure", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const workflow = client.defineWorkflow(
            { name: "caught-rethrown-step-error", retryPolicy: { maximumAttempts: 1 } },
            async ({ step }) => {
                return await step.run({ name: "failing-step", retryPolicy: { maximumAttempts: 1 } }, () => {
                    try {
                        throwStepVisibleFailure();
                    } catch (error) {
                        throw error;
                    }
                });
            }
        );
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "failed")
        );

        const failed = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
        const [attempt] = backend.stepAttempts(handle.workflowRun.id);
        expect(failed?.error?.message).toBe("step visible failure");
        expect(failed?.error?.stack).toContain("STEP_ORIGINAL_THROW_ORIGIN");
        expect(failed?.error?.cause?.message).toBe("step root cause");
        expect(failed?.error?.cause?.stack).toContain("STEP_ROOT_ORIGIN");
        expect(attempt?.error?.message).toBe("step visible failure");
        expect(attempt?.error?.stack).toContain("STEP_ORIGINAL_THROW_ORIGIN");
        expect(attempt?.error?.cause?.message).toBe("step root cause");
        expect(attempt?.error?.cause?.stack).toContain("STEP_ROOT_ORIGIN");
    });

    test("rejects invalid workflow input before creating a run", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const workflow = client.defineWorkflow<number, number, unknown>(
            { name: "validated-input", schema: positiveNumberSchema() },
            ({ input }) => input * 2
        );

        await expect(workflow.run("bad-input")).rejects.toThrow("Expected a positive number");

        expect(await backend.countWorkflowRuns()).toEqual({
            pending: 0,
            running: 0,
            completed: 0,
            failed: 0,
            canceled: 0,
        });
    });

    test("honors workflow run idempotency keys without replacing the original input", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const workflow = client.defineWorkflow<{ readonly value: number }, number>(
            { name: "idempotent-run" },
            ({ input }) => input.value
        );

        const first = await workflow.run({ value: 1 }, { idempotencyKey: "same-key" });
        const second = await workflow.run({ value: 999 }, { idempotencyKey: "same-key" });
        const third = await workflow.run({ value: 2 }, { idempotencyKey: "different-key" });

        expect(second.workflowRun.id).toBe(first.workflowRun.id);
        expect(second.workflowRun.input).toEqual({ value: 1 });
        expect(third.workflowRun.id).not.toBe(first.workflowRun.id);
        expect(await backend.countWorkflowRuns()).toEqual({
            pending: 2,
            running: 0,
            completed: 0,
            failed: 0,
            canceled: 0,
        });
    });

    test("replays completed steps from history when a workflow-level retry reruns the function", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        let expensiveCalls = 0;
        const workflow = client.defineWorkflow(
            {
                name: "workflow-replay-cache",
                retryPolicy: {
                    initialInterval: "0ms",
                    maximumInterval: "0ms",
                    backoffCoefficient: 1,
                    maximumAttempts: 2,
                },
            },
            async ({ step, run }) => {
                const value = await step.run({ name: "expensive" }, () => {
                    expensiveCalls += 1;
                    return "cached-value";
                });
                if (run.retryAttempt === 1) {
                    throw new Error("fail after durable step");
                }
                return value;
            }
        );
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "pending")
        );
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "completed")
        );

        const completed = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
        expect(completed?.output).toBe("cached-value");
        expect(expensiveCalls).toBe(1);
        expect(
            backend.stepAttempts(handle.workflowRun.id).filter((attempt) => attempt.stepName === "expensive")
        ).toHaveLength(1);
    });

    test("does not re-send a completed step.sendSignal when a workflow retry replays after a crash", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const workflow = client.defineWorkflow(
            {
                name: "send-signal-replay",
                retryPolicy: {
                    initialInterval: "0ms",
                    maximumInterval: "0ms",
                    backoffCoefficient: 1,
                    maximumAttempts: 2,
                },
            },
            async ({ step, run }) => {
                const result = await step.sendSignal({ signal: "notify", data: { value: 1 } });
                if (run.retryAttempt === 1) {
                    throw new Error("crash after signal send");
                }
                return result.workflowRunIds.length;
            }
        );
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "pending")
        );
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "completed")
        );

        expect(backend.signalSendCallCount).toBe(1);
        expect(
            backend.stepAttempts(handle.workflowRun.id).filter((attempt) => attempt.kind === "signal-send")
        ).toHaveLength(1);
    });

    test("retries a failed step attempt without completing the workflow until the retry succeeds", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        let attempts = 0;
        const workflow = client.defineWorkflow({ name: "step-retry" }, async ({ step }) => {
            return await step.run(
                {
                    name: "unstable-step",
                    retryPolicy: {
                        initialInterval: "0ms",
                        maximumInterval: "0ms",
                        backoffCoefficient: 1,
                        maximumAttempts: 2,
                    },
                },
                () => {
                    attempts += 1;
                    if (attempts === 1) {
                        throw new Error("transient step failure");
                    }
                    return "recovered";
                }
            );
        });
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "pending")
        );
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "completed")
        );

        const completed = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
        expect(completed?.output).toBe("recovered");
        expect(backend.stepAttempts(handle.workflowRun.id).map((attempt) => attempt.status)).toEqual([
            "failed",
            "completed",
        ]);
    });

    test("reconciles a stale running function attempt before recording the retry attempt", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const workflow = client.defineWorkflow({ name: "stale-step-retry-sequencing" }, async ({ step }) => {
            return await step.run({ name: "durable-step" }, () => "replacement-output");
        });
        const run = await workflow.run();
        const staleClaim = await backend.claimNextRunnableWorkflow({ workerId: "stale-worker", leaseDurationMs: 0 });
        expect(staleClaim?.id).toBe(run.workflowRun.id);
        const staleAttempt = await backend.startStepAttempt({
            workflowRunId: run.workflowRun.id,
            workerId: "stale-worker",
            stepName: "durable-step",
            kind: "function",
            config: {
                retryPolicy: {
                    initialInterval: "0ms",
                    maximumInterval: "0ms",
                    backoffCoefficient: 1,
                    maximumAttempts: 2,
                },
            },
            context: null,
        });
        const worker = client.newWorker();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((candidate) => candidate.id === run.workflowRun.id && candidate.status === "pending")
        );

        const afterReconciliation = await backend.getWorkflowRun({ workflowRunId: run.workflowRun.id });
        expect(afterReconciliation?.workerId).toBeNull();
        expect(afterReconciliation?.error?.message).toBe("Step durable-step was left running by a stale worker lease");
        expect(
            backend.stepAttempts(run.workflowRun.id).map((attempt) => ({ id: attempt.id, status: attempt.status }))
        ).toEqual([{ id: staleAttempt.id, status: "failed" }]);

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((candidate) => candidate.id === run.workflowRun.id && candidate.status === "completed")
        );

        const completed = await backend.getWorkflowRun({ workflowRunId: run.workflowRun.id });
        const attempts = backend.stepAttempts(run.workflowRun.id);
        expect(completed?.output).toBe("replacement-output");
        expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.id).toBe(staleAttempt.id);
        expect(attempts[1]?.id).not.toBe(staleAttempt.id);
    });

    test("parks on signal waits, delivers matching signals once, and resumes with validated data", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const workflow = client.defineWorkflow({ name: "signal-resume" }, async ({ step }) => {
            const delivered = await step.waitForSignal({ signal: "go", schema: positiveNumberSchema() });
            return delivered?.data ?? 0;
        });
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.workerId === null)
        );

        const firstSignal = await client.sendSignal({ signal: "go", data: 42, idempotencyKey: "signal-key" });
        const duplicateSignal = await client.sendSignal({ signal: "go", data: 100, idempotencyKey: "signal-key" });
        expect(firstSignal).toEqual({ workflowRunIds: [handle.workflowRun.id] });
        expect(duplicateSignal).toEqual(firstSignal);

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "completed")
        );

        const completed = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
        expect(completed?.output).toBe(42);
        expect(
            backend
                .stepAttempts(handle.workflowRun.id)
                .filter((attempt) => attempt.kind === "signal-wait" && attempt.status === "completed")
        ).toHaveLength(1);
    });

    test("fails the workflow when delivered signal data does not satisfy the wait schema", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const workflow = client.defineWorkflow({ name: "signal-validation-failure" }, async ({ step }) => {
            const delivered = await step.waitForSignal({ signal: "validated", schema: positiveNumberSchema() });
            return delivered?.data ?? 0;
        });
        const worker = client.newWorker();
        const handle = await workflow.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.workerId === null)
        );
        await client.sendSignal({ signal: "validated", data: "not-a-number" });
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === handle.workflowRun.id && run.status === "failed")
        );

        const failed = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
        expect(failed?.error?.message).toContain("Expected a positive number");
        expect(backend.stepAttempts(handle.workflowRun.id).at(-1)?.status).toBe("failed");
    });

    test("parks Promise.all child workflow fan-out until every child completes", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const child = client.defineWorkflow<number, number>({ name: "all-parking-child" }, ({ input }) => input * 10);
        const parent = client.defineWorkflow({ name: "all-parking-parent" }, async ({ step }) => {
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
        await backend.waitForWorkflowRuns((runs) =>
            runs.some(
                (run) => run.id === parentHandle.workflowRun.id && run.status === "running" && run.workerId === null
            )
        );

        const parkedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(parkedParent?.status).toBe("running");
        expect(parkedParent?.workerId).toBeNull();
        expect(parkedParent?.output).toBeNull();
        expect(parkedParent?.error).toBeNull();

        const childRuns = backend.childWorkflowRuns(parentHandle.workflowRun.id);
        expect(childRuns.map((run) => run.status)).toEqual(["pending", "pending", "pending"]);
        for (const childRun of childRuns) {
            await runReadyWorkflow(worker);
            await backend.waitForWorkflowRuns((runs) =>
                runs.some((run) => run.id === childRun.id && run.status === "completed")
            );

            const parkedAfterChild = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
            expect(parkedAfterChild?.status).toBe("running");
            expect(parkedAfterChild?.workerId).toBeNull();
            expect(parkedAfterChild?.output).toBeNull();
            expect(parkedAfterChild?.error).toBeNull();
        }

        expect(backend.stepAttempts(parentHandle.workflowRun.id).map((attempt) => attempt.status)).toEqual([
            "running",
            "running",
            "running",
        ]);

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.status === "completed")
        );

        const completedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(completedParent?.output).toEqual([10, 20, 30]);
        expect(
            backend.stepAttempts(parentHandle.workflowRun.id).map((attempt) => [attempt.status, attempt.output])
        ).toEqual([
            ["completed", 10],
            ["completed", 20],
            ["completed", 30],
        ]);
    });

    test("lets Promise.allSettled observe a failed child without aborting while siblings remain outstanding", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const child = client.defineWorkflow<number, number>(
            { name: "settled-parking-child", retryPolicy: { maximumAttempts: 1 } },
            ({ input }) => {
                if (input === 1) {
                    throw new Error("child exploded");
                }
                return input * 10;
            }
        );
        const parent = client.defineWorkflow({ name: "settled-parking-parent" }, async ({ step }) => {
            const settled = await Promise.allSettled([
                step.runWorkflow(child.workflow.spec, 1, { name: "rejecting-child" }),
                step.runWorkflow(child.workflow.spec, 2, { name: "fulfilled-child" }),
            ]);
            return settled.map((result) =>
                result.status === "fulfilled"
                    ? { status: result.status, value: result.value }
                    : {
                          status: result.status,
                          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
                      }
            );
        });
        const worker = client.newWorker();
        const parentHandle = await parent.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns(() => backend.childWorkflowRuns(parentHandle.workflowRun.id).length === 2);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some(
                (run) => run.id === parentHandle.workflowRun.id && run.status === "running" && run.workerId === null
            )
        );
        const [rejectingChild, fulfilledChild] = backend.childWorkflowRuns(parentHandle.workflowRun.id);
        expect(rejectingChild?.input).toBe(1);
        expect(fulfilledChild?.input).toBe(2);

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === rejectingChild!.id && run.status === "failed")
        );

        const parentAfterRejectedChild = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(parentAfterRejectedChild?.status).toBe("running");
        expect(parentAfterRejectedChild?.workerId).toBeNull();
        expect(parentAfterRejectedChild?.output).toBeNull();
        expect(parentAfterRejectedChild?.error).toBeNull();
        const outstandingSibling = await backend.getWorkflowRun({ workflowRunId: fulfilledChild!.id });
        expect(outstandingSibling?.status).toBe("pending");

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === fulfilledChild!.id && run.status === "completed")
        );

        const parentAfterChildren = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(parentAfterChildren?.status).toBe("running");
        expect(parentAfterChildren?.workerId).toBeNull();
        expect(parentAfterChildren?.output).toBeNull();
        expect(parentAfterChildren?.error).toBeNull();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.status === "completed")
        );

        const completedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(completedParent?.output).toEqual([
            { status: "rejected", reason: "child exploded" },
            { status: "fulfilled", value: 20 },
        ]);
        const attempts = backend.stepAttempts(parentHandle.workflowRun.id);
        expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
        expect(attempts[0]?.error?.message).toContain("child exploded");
        expect(attempts[1]?.output).toBe(20);
    });

    test("blocks parent completion on externally added children and records their output before resuming", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const child = client.defineWorkflow<number, number>({ name: "external-child" }, ({ input }) => input * 2);
        const parent = client.defineWorkflow({ name: "external-parent" }, async ({ step }) => {
            const delivered = await step.waitForSignal({ signal: "finish" });
            return delivered?.data ?? "missing";
        });
        const worker = client.newWorker();
        const parentHandle = await parent.run();

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.workerId === null)
        );

        const external = await client.addChildWorkflowRun(
            parentHandle.workflowRun.id,
            "external-step",
            child.workflow.spec,
            7
        );
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === external.workflowRun.id && run.status === "completed")
        );

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.workerId === null)
        );
        const parkedAfterChild = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(parkedAfterChild?.status).toBe("running");
        expect(parkedAfterChild?.workerId).toBeNull();

        await client.sendSignal({ signal: "finish", data: "done" });
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.status === "completed")
        );

        const completedParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        const externalAttempt = backend
            .stepAttempts(parentHandle.workflowRun.id)
            .find((attempt) => attempt.stepName === "external-step");
        expect(completedParent?.output).toBe("done");
        expect(externalAttempt?.status).toBe("completed");
        expect(externalAttempt?.output).toBe(14);
    });

    test("does not deadlock a stale expired lease only because a function step was left running", async () => {
        const backend = new ContractTestWorkflowBackend();
        const run = await backend.createWorkflowRun({
            workflowName: "stale-function-step",
            version: null,
            idempotencyKey: null,
            config: {},
            context: null,
            input: null,
            parentStepAttemptNamespaceId: null,
            parentStepAttemptId: null,
            availableAt: null,
            deadlineAt: null,
        });
        const firstClaim = await backend.claimNextRunnableWorkflow({ workerId: "stale-worker", leaseDurationMs: 0 });
        expect(firstClaim?.id).toBe(run.id);
        await backend.createStepAttempt({
            workflowRunId: run.id,
            workerId: "stale-worker",
            stepName: "abandoned",
            kind: "function",
            config: {},
            context: null,
        });

        const handoff = await backend.claimWorkflowRun({ workerId: "replacement-worker", leaseDurationMs: 1000 });

        expect(handoff?.id).toBe(run.id);
        expect(handoff?.workerId).toBe("replacement-worker");
    });

    test("recovers child workflow waits when the child run exists but step linkage was lost before retry", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const child = client.defineWorkflow<number, string>(
            { name: "link-recovery-child" },
            ({ input }) => `child:${input}`
        );
        const parent = client.defineWorkflow(
            {
                name: "link-recovery-parent",
                retryPolicy: {
                    initialInterval: "0ms",
                    maximumInterval: "0ms",
                    backoffCoefficient: 1,
                    maximumAttempts: 2,
                },
            },
            async ({ step }) => await step.runWorkflow(child.workflow.spec, 6, { name: "recoverable-child" })
        );
        const worker = client.newWorker();
        const parentHandle = await parent.run();
        backend.failNextChildLink = true;

        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.status === "pending")
        );
        const childRun = backend.childWorkflowRuns(parentHandle.workflowRun.id)[0];
        expect(childRun).toBeDefined();
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.workerId === null)
        );
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === childRun!.id && run.status === "completed")
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const currentParent = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
            if (currentParent?.status === "completed") {
                break;
            }
            await worker.tick();
            await flushRuntimeMicrotasks();
        }
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.status === "completed")
        );

        const parentRun = await backend.getWorkflowRun({ workflowRunId: parentHandle.workflowRun.id });
        expect(parentRun?.status).toBe("completed");
        expect(parentRun?.output).toBe("child:6");
    });

    test("keeps externally sent no-waiter signals idempotent", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });

        const first = await client.sendSignal({ signal: "nobody", data: "first", idempotencyKey: "empty-signal" });
        const duplicate = await client.sendSignal({ signal: "nobody", data: "second", idempotencyKey: "empty-signal" });

        expect(first).toEqual({ workflowRunIds: [] });
        expect(duplicate).toEqual(first);
        expect(backend.signalSendCallCount).toBe(1);
    });

    test("makes externally added child workflow runs idempotent and stores undefined input as null", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const child = client.defineWorkflow(
            { name: "external-null-input-child" },
            ({ input }) => input ?? "null-input"
        );
        const parent = client.defineWorkflow({ name: "external-idempotent-parent" }, async ({ step }) => {
            await step.waitForSignal({ signal: "keep-parent-open" });
            return "done";
        });
        const worker = client.newWorker();
        const parentHandle = await parent.run();
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === parentHandle.workflowRun.id && run.workerId === null)
        );

        const first = await client.addChildWorkflowRun(
            parentHandle.workflowRun.id,
            "same-external-step",
            child.workflow.spec
        );
        const duplicate = await client.addChildWorkflowRun(
            parentHandle.workflowRun.id,
            "same-external-step",
            child.workflow.spec
        );
        const externalAttempts = backend
            .stepAttempts(parentHandle.workflowRun.id)
            .filter((attempt) => attempt.stepName === "same-external-step");

        expect(duplicate.workflowRun.id).toBe(first.workflowRun.id);
        expect(externalAttempts).toHaveLength(1);
        expect(first.workflowRun.input).toBeNull();
    });
    test("rejects stale heartbeats and completion after a later worker reclaims an expired lease", async () => {
        const backend = new ContractTestWorkflowBackend();
        const run = await backend.createWorkflowRun({
            workflowName: "lease-owned",
            version: null,
            idempotencyKey: null,
            config: {},
            context: null,
            input: null,
            parentStepAttemptNamespaceId: null,
            parentStepAttemptId: null,
            availableAt: null,
            deadlineAt: null,
        });

        const firstClaim = await backend.claimWorkflowRun({ workerId: "worker-one", leaseDurationMs: 1000 });
        expect(firstClaim?.id).toBe(run.id);
        const heartbeat = await backend.extendWorkflowRunLease({
            workflowRunId: run.id,
            workerId: "worker-one",
            leaseDurationMs: 1000,
        });
        expect(heartbeat.workerId).toBe("worker-one");
        expect(await backend.claimWorkflowRun({ workerId: "worker-two", leaseDurationMs: 1000 })).toBeNull();

        await backend.extendWorkflowRunLease({ workflowRunId: run.id, workerId: "worker-one", leaseDurationMs: 0 });
        const secondClaim = await backend.claimWorkflowRun({ workerId: "worker-two", leaseDurationMs: 1000 });

        expect(secondClaim?.id).toBe(run.id);
        expect(secondClaim?.workerId).toBe("worker-two");
        expect(secondClaim?.attempts).toBe(2);
        await expect(
            backend.extendWorkflowRunLease({ workflowRunId: run.id, workerId: "worker-one", leaseDurationMs: 1000 })
        ).rejects.toThrow("Workflow run is not owned by worker");
        await expect(
            backend.completeWorkflowRun({ workflowRunId: run.id, workerId: "worker-one", output: "stale-finish" })
        ).rejects.toThrow("Workflow run is not owned by worker");
        await backend.completeWorkflowRun({ workflowRunId: run.id, workerId: "worker-two", output: "finished" });

        const completed = await backend.getWorkflowRun({ workflowRunId: run.id });
        expect(completed?.status).toBe("completed");
        expect(completed?.output).toBe("finished");
        expect(completed?.workerId).toBeNull();
    });

    test("surfaces cancellation and workflow failure through run handles", async () => {
        const backend = new ContractTestWorkflowBackend();
        const client = new WorkflowClient({ backend });
        const cancelable = client.defineWorkflow({ name: "cancelable" }, () => "should-not-run");
        const failing = client.defineWorkflow({ name: "failing", retryPolicy: { maximumAttempts: 1 } }, () => {
            throw new Error("top-level boom");
        });
        const worker = client.newWorker();

        const canceledHandle = await cancelable.run();
        await canceledHandle.cancel();
        await expect(canceledHandle.result({ timeoutMs: 1 })).rejects.toThrow("Workflow cancelable was canceled");

        const failingHandle = await failing.run();
        await runReadyWorkflow(worker);
        await backend.waitForWorkflowRuns((runs) =>
            runs.some((run) => run.id === failingHandle.workflowRun.id && run.status === "failed")
        );
        await expect(failingHandle.result({ timeoutMs: 1 })).rejects.toThrow("top-level boom");
    });

    test("paginates workflow and step lists and returns counts by observable status", async () => {
        const backend = new ContractTestWorkflowBackend();
        const first = await backend.createWorkflowRun({
            workflowName: "first",
            version: null,
            idempotencyKey: null,
            config: {},
            context: null,
            input: null,
            parentStepAttemptNamespaceId: null,
            parentStepAttemptId: null,
            availableAt: null,
            deadlineAt: null,
        });
        const second = await backend.createWorkflowRun({
            workflowName: "second",
            version: null,
            idempotencyKey: null,
            config: {},
            context: null,
            input: null,
            parentStepAttemptNamespaceId: null,
            parentStepAttemptId: null,
            availableAt: null,
            deadlineAt: null,
        });
        const third = await backend.createWorkflowRun({
            workflowName: "third",
            version: null,
            idempotencyKey: null,
            config: {},
            context: null,
            input: null,
            parentStepAttemptNamespaceId: null,
            parentStepAttemptId: null,
            availableAt: null,
            deadlineAt: null,
        });

        const firstPage = await backend.listWorkflowRuns({ limit: 2 });
        const secondPage = await backend.listWorkflowRuns({ limit: 2, after: firstPage.pagination.next ?? undefined });
        expect(firstPage.data.map((run) => run.id)).toEqual([first.id, second.id]);
        expect(firstPage.pagination.next).toBe(second.id);
        expect(secondPage.data.map((run) => run.id)).toEqual([third.id]);
        expect(secondPage.pagination.next).toBeNull();
        expect(secondPage.pagination.prev).toBe(third.id);

        const claimedFirst = await backend.claimWorkflowRun({ workerId: "counter", leaseDurationMs: 1000 });
        expect(claimedFirst?.id).toBe(first.id);
        const stepOne = await backend.createStepAttempt({
            workflowRunId: first.id,
            workerId: "counter",
            stepName: "one",
            kind: "function",
            config: {},
            context: null,
        });
        const stepTwo = await backend.createStepAttempt({
            workflowRunId: first.id,
            workerId: "counter",
            stepName: "two",
            kind: "function",
            config: {},
            context: null,
        });
        const stepPage = await backend.listStepAttempts({ workflowRunId: first.id, limit: 1 });
        const nextStepPage = await backend.listStepAttempts({
            workflowRunId: first.id,
            limit: 1,
            after: stepPage.pagination.next ?? undefined,
        });
        expect(stepPage.data.map((attempt) => attempt.id)).toEqual([stepOne.id]);
        expect(stepPage.pagination.next).toBe(stepOne.id);
        expect(nextStepPage.data.map((attempt) => attempt.id)).toEqual([stepTwo.id]);

        await backend.completeStepAttempt({
            workflowRunId: first.id,
            stepAttemptId: stepOne.id,
            workerId: "counter",
            output: "one",
        });
        await backend.completeStepAttempt({
            workflowRunId: first.id,
            stepAttemptId: stepTwo.id,
            workerId: "counter",
            output: "two",
        });
        await backend.completeWorkflowRun({ workflowRunId: first.id, workerId: "counter", output: "done" });
        await backend.cancelWorkflowRun({ workflowRunId: second.id });
        const claimedThird = await backend.claimWorkflowRun({ workerId: "counter", leaseDurationMs: 1000 });
        expect(claimedThird?.id).toBe(third.id);
        await backend.failWorkflowRun({
            workflowRunId: third.id,
            workerId: "counter",
            error: { message: "permanent" },
            retryPolicy: { initialInterval: "0ms", maximumInterval: "0ms", backoffCoefficient: 1, maximumAttempts: 1 },
            attempts: 1,
            deadlineAt: null,
        });

        expect(await backend.countWorkflowRuns()).toEqual({
            pending: 0,
            running: 0,
            completed: 1,
            failed: 1,
            canceled: 1,
        });
    });
});
