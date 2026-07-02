import { sql, type SQL } from "@kiwi/db/drizzle";
import { runDatabaseEffect, tryDb } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";
import { ulid } from "ulid";
import {
    computeFailedWorkflowRunUpdate,
    type JsonValue,
    type RetryPolicy,
    type SerializedError,
    type StepAttempt,
    type StepAttemptContext,
    type StepKind,
    type WorkflowRun,
    type WorkflowRunStatus,
} from "./core";
import { WORKFLOW_NAMESPACE_ID } from "@kiwi/db/tables/workflow";

export const DEFAULT_NAMESPACE_ID = WORKFLOW_NAMESPACE_ID;
export const DEFAULT_RUN_IDEMPOTENCY_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface PaginationOptions {
    readonly limit?: number;
    readonly after?: string;
    readonly before?: string;
}

export interface PaginatedResponse<T> {
    readonly data: T[];
    readonly pagination: {
        readonly next: string | null;
        readonly prev: string | null;
    };
}

export type WorkflowRunCounts = Omit<Record<WorkflowRunStatus, number>, "succeeded" | "sleeping">;

export interface CreateWorkflowRunParams {
    readonly workflowName: string;
    readonly version: string | null;
    readonly idempotencyKey: string | null;
    readonly config: JsonValue;
    readonly context: JsonValue | null;
    readonly input: JsonValue | null;
    readonly parentStepAttemptNamespaceId: string | null;
    readonly parentStepAttemptId: string | null;
    readonly availableAt: Date | null;
    readonly deadlineAt: Date | null;
}

export interface GetWorkflowRunParams {
    readonly workflowRunId: string;
}

export type ListWorkflowRunsParams = PaginationOptions;

export interface ClaimWorkflowRunParams {
    readonly workerId: string;
    readonly leaseDurationMs: number;
}

export interface ExtendWorkflowRunLeaseParams {
    readonly workflowRunId: string;
    readonly workerId: string;
    readonly leaseDurationMs: number;
}

export interface SleepWorkflowRunParams {
    readonly workflowRunId: string;
    readonly workerId: string;
    readonly availableAt: Date;
}

export interface CompleteWorkflowRunParams {
    readonly workflowRunId: string;
    readonly workerId: string;
    readonly output: JsonValue | null;
}

export interface FailWorkflowRunParams {
    readonly workflowRunId: string;
    readonly workerId: string;
    readonly error: SerializedError;
    readonly retryPolicy: RetryPolicy;
    readonly attempts?: number;
    readonly deadlineAt?: Date | null;
}

export interface RescheduleWorkflowRunAfterFailedStepAttemptParams {
    readonly workflowRunId: string;
    readonly workerId: string;
    readonly error: SerializedError;
    readonly availableAt: Date;
}

export interface CancelWorkflowRunParams {
    readonly workflowRunId: string;
}

export interface CreateStepAttemptParams {
    readonly workflowRunId: string;
    readonly workerId: string;
    readonly stepName: string;
    readonly kind: StepKind;
    readonly idempotencyKey?: string | null;
    readonly config: JsonValue;
    readonly context: StepAttemptContext | null;
}

export interface GetStepAttemptParams {
    readonly stepAttemptId: string;
}

export interface ListStepAttemptsParams extends PaginationOptions {
    readonly workflowRunId: string;
}

export interface CompleteStepAttemptParams {
    readonly workflowRunId: string;
    readonly stepAttemptId: string;
    readonly workerId: string;
    readonly output: JsonValue | null;
}

export interface FailStepAttemptParams {
    readonly workflowRunId: string;
    readonly stepAttemptId: string;
    readonly workerId: string;
    readonly error: SerializedError;
}

export interface SetStepAttemptChildWorkflowRunParams {
    readonly workflowRunId: string;
    readonly stepAttemptId: string;
    readonly workerId: string;
    readonly childWorkflowRunNamespaceId: string;
    readonly childWorkflowRunId: string;
}

export interface SendSignalParams {
    readonly signal: string;
    readonly data: JsonValue | null;
    readonly idempotencyKey: string | null;
}

export interface SendSignalResult {
    readonly workflowRunIds: string[];
}

export interface GetSignalDeliveryParams {
    readonly stepAttemptId: string;
}

export interface AddChildWorkflowRunParams<Input = unknown> {
    readonly parentWorkflowRunId: string;
    readonly stepName: string;
    readonly workflowName: string;
    readonly version: string | null;
    readonly input: Input;
    readonly config?: JsonValue;
    readonly timeoutAt?: Date | null;
    readonly idempotencyKey?: string;
}

export interface AddChildWorkflowRunResult {
    readonly stepAttempt: StepAttempt;
    readonly workflowRun: WorkflowRun;
}

export type StartWorkflowRunParams = Omit<
    CreateWorkflowRunParams,
    "parentStepAttemptNamespaceId" | "parentStepAttemptId"
>;

export type ParkClaimedWorkflowParams = SleepWorkflowRunParams;

export type RecordStepAttemptResultParams =
    | (CompleteStepAttemptParams & { readonly status: "completed" })
    | (FailStepAttemptParams & { readonly status: "failed" });

export interface StartChildWorkflowParams<Input = unknown> {
    readonly parentWorkflowRunId: string;
    readonly stepName: string;
    readonly workflowName: string;
    readonly version: string | null;
    readonly input: Input;
    readonly config?: JsonValue;
    readonly timeoutAt?: Date | null;
    readonly idempotencyKey?: string;
    readonly workerId?: string;
    readonly stepAttemptId?: string;
}

export type StartChildWorkflowResult = AddChildWorkflowRunResult;

export interface Backend {
    startWorkflowRun(params: Readonly<StartWorkflowRunParams>): Promise<WorkflowRun>;
    getWorkflowRun(params: Readonly<GetWorkflowRunParams>): Promise<WorkflowRun | null>;
    listWorkflowRuns(params: Readonly<ListWorkflowRunsParams>): Promise<PaginatedResponse<WorkflowRun>>;
    countWorkflowRuns(): Promise<WorkflowRunCounts>;
    claimNextRunnableWorkflow(params: Readonly<ClaimWorkflowRunParams>): Promise<WorkflowRun | null>;
    heartbeatClaim(params: Readonly<ExtendWorkflowRunLeaseParams>): Promise<WorkflowRun>;
    parkClaimedWorkflow(params: Readonly<ParkClaimedWorkflowParams>): Promise<WorkflowRun>;
    completeClaimedWorkflow(params: Readonly<CompleteWorkflowRunParams>): Promise<WorkflowRun>;
    failClaimedWorkflow(params: Readonly<FailWorkflowRunParams>): Promise<WorkflowRun>;
    rescheduleClaimedWorkflowAfterStepFailure(
        params: Readonly<RescheduleWorkflowRunAfterFailedStepAttemptParams>
    ): Promise<WorkflowRun>;
    cancelWorkflowRun(params: Readonly<CancelWorkflowRunParams>): Promise<WorkflowRun>;
    startStepAttempt(params: Readonly<CreateStepAttemptParams>): Promise<StepAttempt>;
    listStepAttempts(params: Readonly<ListStepAttemptsParams>): Promise<PaginatedResponse<StepAttempt>>;
    recordStepAttemptResult(params: Readonly<RecordStepAttemptResultParams>): Promise<StepAttempt>;
    startChildWorkflow<Input>(params: Readonly<StartChildWorkflowParams<Input>>): Promise<StartChildWorkflowResult>;
    deliverSignal(params: Readonly<SendSignalParams>): Promise<SendSignalResult>;
    awaitSignal(params: Readonly<GetSignalDeliveryParams>): Promise<JsonValue | undefined>;
    stop(): Promise<void>;
}

interface WorkflowRunRow {
    namespaceId: string;
    id: string;
    workflowName: string;
    version: string | null;
    status: WorkflowRunStatus;
    idempotencyKey: string | null;
    config: JsonValue | null;
    context: JsonValue | null;
    input: JsonValue | null;
    output: JsonValue | null;
    error: SerializedError | null;
    attempts: number;
    parentStepAttemptNamespaceId: string | null;
    parentStepAttemptId: string | null;
    workerId: string | null;
    availableAt: Date | string | null;
    deadlineAt: Date | string | null;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
}

interface StepAttemptRow {
    namespaceId: string;
    id: string;
    workflowRunId: string;
    stepName: string;
    kind: StepKind;
    status: StepAttempt["status"];
    config: JsonValue | null;
    context: StepAttemptContext | null;
    output: JsonValue | null;
    error: SerializedError | null;
    childWorkflowRunNamespaceId: string | null;
    childWorkflowRunId: string | null;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
}

const workflowRunColumns = sql`
    "namespace_id" AS "namespaceId",
    "id",
    "workflow_name" AS "workflowName",
    "version",
    "status",
    "idempotency_key" AS "idempotencyKey",
    "config",
    "context",
    "input",
    "output",
    "error",
    "attempts",
    "parent_step_attempt_namespace_id" AS "parentStepAttemptNamespaceId",
    "parent_step_attempt_id" AS "parentStepAttemptId",
    "worker_id" AS "workerId",
    "available_at" AS "availableAt",
    "deadline_at" AS "deadlineAt",
    "started_at" AS "startedAt",
    "finished_at" AS "finishedAt",
    "created_at" AS "createdAt",
    "updated_at" AS "updatedAt"
`;

const stepAttemptColumns = sql`
    "namespace_id" AS "namespaceId",
    "id",
    "workflow_run_id" AS "workflowRunId",
    "step_name" AS "stepName",
    "kind",
    "status",
    "config",
    "context",
    "output",
    "error",
    "child_workflow_run_namespace_id" AS "childWorkflowRunNamespaceId",
    "child_workflow_run_id" AS "childWorkflowRunId",
    "started_at" AS "startedAt",
    "finished_at" AS "finishedAt",
    "created_at" AS "createdAt",
    "updated_at" AS "updatedAt"
`;

function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null): Date | null {
    return value === null ? null : toDate(value);
}

function mapWorkflowRun(row: WorkflowRunRow): WorkflowRun {
    return {
        namespaceId: row.namespaceId,
        id: row.id,
        workflowName: row.workflowName,
        version: row.version,
        status: row.status,
        idempotencyKey: row.idempotencyKey,
        config: (row.config ?? {}) as JsonValue,
        context: row.context,
        input: row.input,
        output: row.output,
        error: row.error,
        attempts: row.attempts,
        parentStepAttemptNamespaceId: row.parentStepAttemptNamespaceId,
        parentStepAttemptId: row.parentStepAttemptId,
        workerId: row.workerId,
        availableAt: toNullableDate(row.availableAt),
        deadlineAt: toNullableDate(row.deadlineAt),
        startedAt: toNullableDate(row.startedAt),
        finishedAt: toNullableDate(row.finishedAt),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

function mapStepAttempt(row: StepAttemptRow): StepAttempt {
    return {
        namespaceId: row.namespaceId,
        id: row.id,
        workflowRunId: row.workflowRunId,
        stepName: row.stepName,
        kind: row.kind,
        status: row.status,
        config: (row.config ?? {}) as JsonValue,
        context: row.context,
        output: row.output,
        error: row.error,
        childWorkflowRunNamespaceId: row.childWorkflowRunNamespaceId,
        childWorkflowRunId: row.childWorkflowRunId,
        startedAt: toNullableDate(row.startedAt),
        finishedAt: toNullableDate(row.finishedAt),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

function jsonb(value: unknown | null | undefined): SQL {
    if (value === null || value === undefined) {
        return sql`NULL::jsonb`;
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? sql`NULL::jsonb` : sql`${encoded}::jsonb`;
}

function timestampOrNull(value: Date | null): SQL {
    return value === null ? sql`NULL` : sql`${value}`;
}

function timestampOrNow(value: Date | null): SQL {
    return value === null ? sql`NOW()` : sql`${value}`;
}

function rows<T>(value: unknown): T[] {
    return value as T[];
}

function maybeFirst<T>(value: unknown): T | null {
    return rows<T>(value)[0] ?? null;
}

function toWorkflowRunCounts(rows: readonly { status: string; count: number | string }[]): WorkflowRunCounts {
    const counts: WorkflowRunCounts = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        canceled: 0,
    };

    for (const row of rows) {
        const count = Number(row.count);
        switch (row.status) {
            case "pending":
                counts.pending += count;
                break;
            case "running":
            case "sleeping":
                counts.running += count;
                break;
            case "completed":
            case "succeeded":
                counts.completed += count;
                break;
            case "failed":
                counts.failed += count;
                break;
            case "canceled":
                counts.canceled += count;
                break;
        }
    }

    return counts;
}

export interface DrizzleWorkflowBackendOptions {
    readonly namespaceId?: string;
}

export class DrizzleWorkflowBackend implements Backend {
    readonly namespaceId: string;

    constructor(options: DrizzleWorkflowBackendOptions = {}) {
        this.namespaceId = options.namespaceId ?? DEFAULT_NAMESPACE_ID;
    }

    static make(options?: DrizzleWorkflowBackendOptions): DrizzleWorkflowBackend {
        return new DrizzleWorkflowBackend(options);
    }

    async stop(): Promise<void> {}

    async startWorkflowRun(params: Readonly<StartWorkflowRunParams>): Promise<WorkflowRun> {
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

    async parkClaimedWorkflow(params: Readonly<ParkClaimedWorkflowParams>): Promise<WorkflowRun> {
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

    async recordStepAttemptResult(params: Readonly<RecordStepAttemptResultParams>): Promise<StepAttempt> {
        return params.status === "completed" ? this.completeStepAttempt(params) : this.failStepAttempt(params);
    }

    async startChildWorkflow<Input>(
        params: Readonly<StartChildWorkflowParams<Input>>
    ): Promise<StartChildWorkflowResult> {
        if (params.stepAttemptId && params.workerId) {
            const childRun = await this.createWorkflowRun({
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
                childWorkflowRunNamespaceId: childRun.namespaceId,
                childWorkflowRunId: childRun.id,
            });
            return { stepAttempt, workflowRun: childRun };
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
        const id = ulid();
        const inserted = await this.runRows<WorkflowRunRow>(sql`
            INSERT INTO workflow_runs (
                "namespace_id", "id", "workflow_name", "version", "status", "idempotency_key",
                "config", "context", "input", "attempts", "parent_step_attempt_namespace_id",
                "parent_step_attempt_id", "available_at", "deadline_at", "created_at", "updated_at"
            )
            VALUES (
                ${this.namespaceId}, ${id}, ${params.workflowName}, ${params.version}, 'pending', ${params.idempotencyKey},
                ${jsonb(params.config)}, ${jsonb(params.context)}, ${jsonb(params.input)}, 0,
                ${params.parentStepAttemptNamespaceId}, ${params.parentStepAttemptId}, ${timestampOrNow(params.availableAt)},
                ${timestampOrNull(params.deadlineAt)}, date_trunc('milliseconds', NOW()), NOW()
            )
            ON CONFLICT ("namespace_id", "workflow_name", "idempotency_key")
                WHERE "idempotency_key" IS NOT NULL
            DO NOTHING
            RETURNING ${workflowRunColumns}
        `);

        const row = inserted[0];
        if (row) {
            return mapWorkflowRun(row);
        }

        if (params.idempotencyKey === null) {
            throw new Error("Failed to create workflow run");
        }

        const existing = await this.findWorkflowRunByIdempotencyKey(params.workflowName, params.idempotencyKey);
        if (!existing) {
            throw new Error("Failed to create workflow run");
        }
        return existing;
    }

    async getWorkflowRun(params: Readonly<GetWorkflowRunParams>): Promise<WorkflowRun | null> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            SELECT ${workflowRunColumns}
            FROM workflow_runs
            WHERE "namespace_id" = ${this.namespaceId}
              AND "id" = ${params.workflowRunId}
            LIMIT 1
        `);
        return row ? mapWorkflowRun(row) : null;
    }

    async listWorkflowRuns(params: Readonly<ListWorkflowRunsParams>): Promise<PaginatedResponse<WorkflowRun>> {
        const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
        const data = await this.runRows<WorkflowRunRow>(sql`
            SELECT ${workflowRunColumns}
            FROM workflow_runs
            WHERE "namespace_id" = ${this.namespaceId}
            ORDER BY "created_at" DESC, "id" DESC
            LIMIT ${limit}
        `);
        return { data: data.map(mapWorkflowRun), pagination: { next: null, prev: null } };
    }

    async countWorkflowRuns(): Promise<WorkflowRunCounts> {
        const data = await this.runRows<{ status: string; count: string | number }>(sql`
            SELECT "status", COUNT(*) AS "count"
            FROM workflow_runs
            WHERE "namespace_id" = ${this.namespaceId}
            GROUP BY "status"
        `);
        return toWorkflowRunCounts(data);
    }

    private async claimWorkflowRun(params: Readonly<ClaimWorkflowRunParams>): Promise<WorkflowRun | null> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            WITH expired AS (
                UPDATE workflow_runs
                SET "status" = 'failed',
                    "error" = ${jsonb({ message: "Workflow run deadline exceeded" })},
                    "worker_id" = NULL,
                    "available_at" = NULL,
                    "finished_at" = NOW(),
                    "updated_at" = NOW()
                WHERE "namespace_id" = ${this.namespaceId}
                  AND "status" IN ('pending', 'running', 'sleeping')
                  AND "deadline_at" IS NOT NULL
                  AND "deadline_at" <= NOW()
                RETURNING "id"
            ),
            candidate AS (
                SELECT wr."id"
                FROM workflow_runs wr
                WHERE wr."namespace_id" = ${this.namespaceId}
                  AND wr."status" IN ('pending', 'running', 'sleeping')
                  AND wr."available_at" <= NOW()
                  AND (wr."deadline_at" IS NULL OR wr."deadline_at" > NOW())
                ORDER BY CASE WHEN wr."status" = 'pending' THEN 0 ELSE 1 END, wr."available_at", wr."created_at"
                LIMIT 1
            )
            UPDATE workflow_runs wr
            SET "status" = 'running',
                "attempts" = wr."attempts" + 1,
                "worker_id" = ${params.workerId},
                "available_at" = NOW() + ${params.leaseDurationMs} * INTERVAL '1 millisecond',
                "started_at" = COALESCE(wr."started_at", NOW()),
                "updated_at" = NOW()
            FROM candidate
            WHERE wr."namespace_id" = ${this.namespaceId}
              AND wr."id" = candidate."id"
              AND wr."status" IN ('pending', 'running', 'sleeping')
              AND wr."available_at" <= NOW()
              AND (wr."deadline_at" IS NULL OR wr."deadline_at" > NOW())
            RETURNING ${workflowRunColumns}
        `);
        return row ? mapWorkflowRun(row) : null;
    }

    private async extendWorkflowRunLease(params: Readonly<ExtendWorkflowRunLeaseParams>): Promise<WorkflowRun> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            UPDATE workflow_runs
            SET "available_at" = NOW() + ${params.leaseDurationMs} * INTERVAL '1 millisecond',
                "updated_at" = NOW()
            WHERE "namespace_id" = ${this.namespaceId}
              AND "id" = ${params.workflowRunId}
              AND "status" = 'running'
              AND "worker_id" = ${params.workerId}
            RETURNING ${workflowRunColumns}
        `);
        if (!row) {
            throw new Error("Failed to extend lease for workflow run");
        }
        return mapWorkflowRun(row);
    }

    private async sleepWorkflowRun(params: Readonly<SleepWorkflowRunParams>): Promise<WorkflowRun> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            UPDATE workflow_runs
            SET "status" = 'running',
                "available_at" = ${params.availableAt},
                "worker_id" = NULL,
                "updated_at" = NOW()
            WHERE "namespace_id" = ${this.namespaceId}
              AND "id" = ${params.workflowRunId}
              AND "status" NOT IN ('succeeded', 'completed', 'failed', 'canceled')
              AND "worker_id" = ${params.workerId}
            RETURNING ${workflowRunColumns}
        `);
        if (!row) {
            throw new Error("Failed to sleep workflow run");
        }
        const reconciled = await this.reconcileWorkflowSleepWakeUp(params.workflowRunId);
        return reconciled ?? mapWorkflowRun(row);
    }

    private async completeWorkflowRun(params: Readonly<CompleteWorkflowRunParams>): Promise<WorkflowRun> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            UPDATE workflow_runs
            SET "status" = 'completed',
                "output" = ${jsonb(params.output)},
                "error" = NULL,
                "worker_id" = NULL,
                "available_at" = NULL,
                "finished_at" = NOW(),
                "updated_at" = NOW()
            WHERE ${this.runningWorkflowRunOwnedByWorkerWhere(params)}
            RETURNING ${workflowRunColumns}
        `);
        if (!row) {
            throw new Error("Failed to mark workflow run completed");
        }
        const workflowRun = mapWorkflowRun(row);
        await this.wakeParentWorkflowRun(workflowRun);
        return workflowRun;
    }

    private async failWorkflowRun(params: Readonly<FailWorkflowRunParams>): Promise<WorkflowRun> {
        let attempts = params.attempts;
        let deadlineAt = params.deadlineAt;
        if (attempts === undefined || deadlineAt === undefined) {
            const workflowRun = await this.getWorkflowRun({ workflowRunId: params.workflowRunId });
            if (!workflowRun) {
                throw new Error("Workflow run not found");
            }
            attempts = workflowRun.attempts;
            deadlineAt = workflowRun.deadlineAt;
        }

        const failureUpdate = computeFailedWorkflowRunUpdate(
            params.retryPolicy,
            attempts,
            deadlineAt,
            params.error,
            new Date()
        );
        const row = await this.runFirst<WorkflowRunRow>(sql`
            UPDATE workflow_runs
            SET "status" = ${failureUpdate.status},
                "available_at" = ${timestampOrNull(failureUpdate.availableAt)},
                "finished_at" = ${timestampOrNull(failureUpdate.finishedAt)},
                "error" = ${jsonb(failureUpdate.error)},
                "worker_id" = NULL,
                "started_at" = NULL,
                "updated_at" = NOW()
            WHERE ${this.runningWorkflowRunOwnedByWorkerWhere(params)}
            RETURNING ${workflowRunColumns}
        `);
        if (!row) {
            throw new Error("Failed to mark workflow run failed");
        }
        const workflowRun = mapWorkflowRun(row);
        if (workflowRun.status === "failed") {
            await this.wakeParentWorkflowRun(workflowRun);
        }
        return workflowRun;
    }

    private async rescheduleWorkflowRunAfterFailedStepAttempt(
        params: Readonly<RescheduleWorkflowRunAfterFailedStepAttemptParams>
    ): Promise<WorkflowRun> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            UPDATE workflow_runs
            SET "status" = 'pending',
                "available_at" = ${params.availableAt},
                "finished_at" = NULL,
                "error" = ${jsonb(params.error)},
                "worker_id" = NULL,
                "started_at" = NULL,
                "updated_at" = NOW()
            WHERE ${this.runningWorkflowRunOwnedByWorkerWhere(params)}
            RETURNING ${workflowRunColumns}
        `);
        if (!row) {
            throw new Error("Failed to reschedule workflow run after failed step attempt");
        }
        return mapWorkflowRun(row);
    }

    async cancelWorkflowRun(params: Readonly<CancelWorkflowRunParams>): Promise<WorkflowRun> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            UPDATE workflow_runs
            SET "status" = 'canceled',
                "worker_id" = NULL,
                "available_at" = NULL,
                "finished_at" = NOW(),
                "updated_at" = NOW()
            WHERE "namespace_id" = ${this.namespaceId}
              AND "id" = ${params.workflowRunId}
              AND "status" IN ('pending', 'running', 'sleeping')
            RETURNING ${workflowRunColumns}
        `);
        if (!row) {
            const existing = await this.getWorkflowRun(params);
            if (!existing) {
                throw new Error(`Workflow run ${params.workflowRunId} does not exist`);
            }
            if (existing.status === "canceled") {
                return existing;
            }
            if (existing.status === "succeeded" || existing.status === "completed" || existing.status === "failed") {
                throw new Error(`Cannot cancel workflow run ${params.workflowRunId} with status ${existing.status}`);
            }
            throw new Error("Failed to cancel workflow run");
        }
        const workflowRun = mapWorkflowRun(row);
        await this.wakeParentWorkflowRun(workflowRun);
        return workflowRun;
    }

    private async createStepAttempt(params: Readonly<CreateStepAttemptParams>): Promise<StepAttempt> {
        const id = ulid();
        const row = await this.runFirst<StepAttemptRow>(sql`
            INSERT INTO workflow_step_attempts (
                "namespace_id", "id", "workflow_run_id", "step_name", "kind", "status", "idempotency_key", "config", "context",
                "started_at", "created_at", "updated_at"
            )
            SELECT ${this.namespaceId}, ${id}, ${params.workflowRunId}, ${params.stepName}, ${params.kind}, 'running',
                   ${params.idempotencyKey ?? null}, ${jsonb(params.config)}, ${jsonb(params.context)}, NOW(), date_trunc('milliseconds', NOW()), NOW()
            FROM workflow_runs wr
            WHERE wr."namespace_id" = ${this.namespaceId}
              AND wr."id" = ${params.workflowRunId}
              AND wr."status" = 'running'
              AND wr."worker_id" = ${params.workerId}
            RETURNING ${stepAttemptColumns}
        `);
        if (!row) {
            throw new Error("Failed to create step attempt");
        }
        return mapStepAttempt(row);
    }

    private async getStepAttempt(params: Readonly<GetStepAttemptParams>): Promise<StepAttempt | null> {
        const row = await this.runFirst<StepAttemptRow>(sql`
            SELECT ${stepAttemptColumns}
            FROM workflow_step_attempts
            WHERE "namespace_id" = ${this.namespaceId}
              AND "id" = ${params.stepAttemptId}
            LIMIT 1
        `);
        return row ? mapStepAttempt(row) : null;
    }

    async listStepAttempts(params: Readonly<ListStepAttemptsParams>): Promise<PaginatedResponse<StepAttempt>> {
        const limit = Math.min(Math.max(params.limit ?? 1000, 1), 2000);
        const data = await this.runRows<StepAttemptRow>(sql`
            SELECT ${stepAttemptColumns}
            FROM workflow_step_attempts
            WHERE "namespace_id" = ${this.namespaceId}
              AND "workflow_run_id" = ${params.workflowRunId}
            ORDER BY "created_at" ASC, "id" ASC
            LIMIT ${limit}
        `);
        return { data: data.map(mapStepAttempt), pagination: { next: null, prev: null } };
    }

    private async completeStepAttempt(params: Readonly<CompleteStepAttemptParams>): Promise<StepAttempt> {
        const row = await this.runFirst<StepAttemptRow>(sql`
            UPDATE workflow_step_attempts sa
            SET "status" = 'completed',
                "output" = ${jsonb(params.output)},
                "error" = NULL,
                "finished_at" = NOW(),
                "updated_at" = NOW()
            FROM workflow_runs wr
            WHERE ${this.runningStepAttemptOwnedByWorkerWhere(params)}
            RETURNING ${stepAttemptColumns}
        `);
        if (!row) {
            throw new Error("Failed to mark step attempt completed");
        }
        return mapStepAttempt(row);
    }

    private async failStepAttempt(params: Readonly<FailStepAttemptParams>): Promise<StepAttempt> {
        const row = await this.runFirst<StepAttemptRow>(sql`
            UPDATE workflow_step_attempts sa
            SET "status" = 'failed',
                "output" = NULL,
                "error" = ${jsonb(params.error)},
                "finished_at" = NOW(),
                "updated_at" = NOW()
            FROM workflow_runs wr
            WHERE ${this.runningStepAttemptOwnedByWorkerWhere(params)}
            RETURNING ${stepAttemptColumns}
        `);
        if (!row) {
            throw new Error("Failed to mark step attempt failed");
        }
        return mapStepAttempt(row);
    }

    private async setStepAttemptChildWorkflowRun(params: Readonly<SetStepAttemptChildWorkflowRunParams>): Promise<StepAttempt> {
        const row = await this.runFirst<StepAttemptRow>(sql`
            UPDATE workflow_step_attempts sa
            SET "child_workflow_run_namespace_id" = ${params.childWorkflowRunNamespaceId},
                "child_workflow_run_id" = ${params.childWorkflowRunId},
                "updated_at" = NOW()
            FROM workflow_runs wr
            WHERE ${this.runningStepAttemptOwnedByWorkerWhere(params)}
            RETURNING ${stepAttemptColumns}
        `);
        if (!row) {
            throw new Error("Failed to set step attempt child workflow run");
        }
        return mapStepAttempt(row);
    }

    private async sendSignal(params: Readonly<SendSignalParams>): Promise<SendSignalResult> {
        if (params.idempotencyKey === null) {
            const delivered = await this.runRows<{ workflowRunId: string }>(sql`
                WITH waiters AS (
                    SELECT "id", "workflow_run_id"
                    FROM workflow_step_attempts
                    WHERE "namespace_id" = ${this.namespaceId}
                      AND "kind" = 'signal-wait'
                      AND "status" = 'running'
                      AND "context"->>'signal' = ${params.signal}
                ), inserted AS (
                    INSERT INTO workflow_signals (
                        "namespace_id", "id", "signal", "data", "sender_idempotency_key", "workflow_run_id", "step_attempt_id", "created_at"
                    )
                    SELECT ${this.namespaceId}, gen_random_uuid()::text, ${params.signal}, ${jsonb(params.data)}, NULL,
                           waiters."workflow_run_id", waiters."id", NOW()
                    FROM waiters
                    ON CONFLICT ("namespace_id", "step_attempt_id") DO NOTHING
                    RETURNING "workflow_run_id"
                ), wake AS (
                    UPDATE workflow_runs wr
                    SET "available_at" = CASE WHEN wr."available_at" IS NULL OR wr."available_at" > NOW() THEN NOW() ELSE wr."available_at" END,
                        "updated_at" = NOW()
                    WHERE wr."namespace_id" = ${this.namespaceId}
                      AND wr."id" IN (SELECT "workflow_run_id" FROM inserted)
                      AND wr."status" IN ('pending', 'running', 'sleeping')
                      AND wr."worker_id" IS NULL
                    RETURNING wr."id"
                )
                SELECT DISTINCT "workflow_run_id" AS "workflowRunId"
                FROM inserted
            `);
            return { workflowRunIds: delivered.map((row) => row.workflowRunId) };
        }

        const delivered = await this.runRows<{ workflowRunId: string }>(sql`
            WITH send_insert AS (
                INSERT INTO workflow_signal_sends (
                    "namespace_id", "id", "signal", "sender_idempotency_key", "created_at"
                )
                VALUES (${this.namespaceId}, gen_random_uuid()::text, ${params.signal}, ${params.idempotencyKey}, NOW())
                ON CONFLICT ("namespace_id", "signal", "sender_idempotency_key") DO NOTHING
                RETURNING "id"
            ), waiters AS (
                SELECT "id", "workflow_run_id"
                FROM workflow_step_attempts
                WHERE "namespace_id" = ${this.namespaceId}
                  AND "kind" = 'signal-wait'
                  AND "status" = 'running'
                  AND "context"->>'signal' = ${params.signal}
                  AND EXISTS (SELECT 1 FROM send_insert)
            ), inserted AS (
                INSERT INTO workflow_signals (
                    "namespace_id", "id", "signal", "data", "sender_idempotency_key", "workflow_run_id", "step_attempt_id", "created_at"
                )
                SELECT ${this.namespaceId}, gen_random_uuid()::text, ${params.signal}, ${jsonb(params.data)}, ${params.idempotencyKey},
                       waiters."workflow_run_id", waiters."id", NOW()
                FROM waiters
                ON CONFLICT ("namespace_id", "step_attempt_id") DO NOTHING
                RETURNING "workflow_run_id"
            ), wake AS (
                UPDATE workflow_runs wr
                SET "available_at" = CASE WHEN wr."available_at" IS NULL OR wr."available_at" > NOW() THEN NOW() ELSE wr."available_at" END,
                    "updated_at" = NOW()
                WHERE wr."namespace_id" = ${this.namespaceId}
                  AND wr."id" IN (SELECT "workflow_run_id" FROM inserted)
                  AND wr."status" IN ('pending', 'running', 'sleeping')
                  AND wr."worker_id" IS NULL
                RETURNING wr."id"
            ), delivered AS (
                SELECT "workflow_run_id"
                FROM inserted
                UNION
                SELECT "workflow_run_id"
                FROM workflow_signals
                WHERE "namespace_id" = ${this.namespaceId}
                  AND "signal" = ${params.signal}
                  AND "sender_idempotency_key" = ${params.idempotencyKey}
            )
            SELECT DISTINCT "workflow_run_id" AS "workflowRunId"
            FROM delivered
        `);
        return { workflowRunIds: delivered.map((row) => row.workflowRunId) };
    }

    private async getSignalDelivery(params: Readonly<GetSignalDeliveryParams>): Promise<JsonValue | undefined> {
        const row = await this.runFirst<{ data: JsonValue | null }>(sql`
            SELECT "data"
            FROM workflow_signals
            WHERE "namespace_id" = ${this.namespaceId}
              AND "step_attempt_id" = ${params.stepAttemptId}
            LIMIT 1
        `);
        return row ? (row.data ?? null) : undefined;
    }

    private async addChildWorkflowRun<Input>(
        params: Readonly<AddChildWorkflowRunParams<Input>>
    ): Promise<AddChildWorkflowRunResult> {
        const stepAttemptId = ulid();
        const childWorkflowRunId = ulid();
        const idempotencyKey =
            params.idempotencyKey ??
            `__external_child:${this.namespaceId}:${params.parentWorkflowRunId}:${params.stepName}`;
        const baseConfig =
            params.config && typeof params.config === "object" && !Array.isArray(params.config) ? params.config : {};
        const stepConfig = { ...baseConfig, external: true, idempotencyKey } as JsonValue;
        const rows = await this.runRows<
            StepAttemptRow & {
                childNamespaceId: string;
                childId: string;
                childWorkflowName: string;
                childVersion: string | null;
                childStatus: WorkflowRunStatus;
                childIdempotencyKey: string | null;
                childConfig: JsonValue | null;
                childContext: JsonValue | null;
                childInput: JsonValue | null;
                childOutput: JsonValue | null;
                childError: SerializedError | null;
                childAttempts: number;
                childParentStepAttemptNamespaceId: string | null;
                childParentStepAttemptId: string | null;
                childWorkerId: string | null;
                childAvailableAt: Date | string | null;
                childDeadlineAt: Date | string | null;
                childStartedAt: Date | string | null;
                childFinishedAt: Date | string | null;
                childCreatedAt: Date | string;
                childUpdatedAt: Date | string;
            }
        >(sql`
            WITH parent AS (
                SELECT "id"
                FROM workflow_runs
                WHERE "namespace_id" = ${this.namespaceId}
                  AND "id" = ${params.parentWorkflowRunId}
                  AND "status" IN ('pending', 'running', 'sleeping')
                LIMIT 1
            ), existing_child AS (
                SELECT wr.*
                FROM workflow_runs wr
                JOIN parent ON TRUE
                WHERE wr."namespace_id" = ${this.namespaceId}
                  AND wr."workflow_name" = ${params.workflowName}
                  AND wr."idempotency_key" = ${idempotencyKey}
                LIMIT 1
            ), existing_attempt AS (
                SELECT sa.*
                FROM workflow_step_attempts sa
                JOIN existing_child child
                  ON child."parent_step_attempt_namespace_id" = sa."namespace_id"
                 AND child."parent_step_attempt_id" = sa."id"
                LIMIT 1
            ), attempt_insert AS (
                INSERT INTO workflow_step_attempts (
                    "namespace_id", "id", "workflow_run_id", "step_name", "kind", "status", "idempotency_key", "config", "context",
                    "started_at", "created_at", "updated_at"
                )
                SELECT ${this.namespaceId}, ${stepAttemptId}, parent."id", ${params.stepName}, 'workflow', 'running',
                       ${idempotencyKey}, ${jsonb(stepConfig)}, ${jsonb({ kind: "workflow", timeoutAt: params.timeoutAt?.toISOString() ?? null })},
                       NOW(), date_trunc('milliseconds', NOW()), NOW()
                FROM parent
                WHERE NOT EXISTS (SELECT 1 FROM existing_attempt)
                RETURNING *
            ), attempt AS (
                SELECT *
                FROM existing_attempt
                UNION ALL
                SELECT *
                FROM attempt_insert
                LIMIT 1
            ), child_insert AS (
                INSERT INTO workflow_runs (
                    "namespace_id", "id", "workflow_name", "version", "status", "idempotency_key", "config", "context", "input",
                    "attempts", "parent_step_attempt_namespace_id", "parent_step_attempt_id", "available_at", "created_at", "updated_at"
                )
                SELECT ${this.namespaceId}, ${childWorkflowRunId}, ${params.workflowName}, ${params.version}, 'pending', ${idempotencyKey},
                       '{}'::jsonb, NULL::jsonb, ${jsonb(params.input as JsonValue)}, 0,
                       ${this.namespaceId}, attempt."id", NOW(), date_trunc('milliseconds', NOW()), NOW()
                FROM attempt
                WHERE NOT EXISTS (SELECT 1 FROM existing_child)
                ON CONFLICT ("namespace_id", "workflow_name", "idempotency_key")
                    WHERE "idempotency_key" IS NOT NULL
                DO NOTHING
                RETURNING *
            ), child AS (
                SELECT *
                FROM existing_child
                UNION ALL
                SELECT *
                FROM child_insert
                UNION ALL
                SELECT wr.*
                FROM workflow_runs wr
                WHERE wr."namespace_id" = ${this.namespaceId}
                  AND wr."workflow_name" = ${params.workflowName}
                  AND wr."idempotency_key" = ${idempotencyKey}
                LIMIT 1
            ), linked AS (
                UPDATE workflow_step_attempts sa
                SET "child_workflow_run_namespace_id" = ${this.namespaceId},
                    "child_workflow_run_id" = child."id",
                    "updated_at" = NOW()
                FROM attempt, child
                WHERE sa."namespace_id" = ${this.namespaceId}
                  AND sa."id" = attempt."id"
                RETURNING sa.*
            ), wake AS (
                UPDATE workflow_runs wr
                SET "available_at" = CASE WHEN wr."available_at" IS NULL OR wr."available_at" > NOW() THEN NOW() ELSE wr."available_at" END,
                    "updated_at" = NOW()
                WHERE wr."namespace_id" = ${this.namespaceId}
                  AND wr."id" = ${params.parentWorkflowRunId}
                  AND wr."worker_id" IS NULL
                RETURNING wr."id"
            )
            SELECT
                linked."namespace_id" AS "namespaceId",
                linked."id",
                linked."workflow_run_id" AS "workflowRunId",
                linked."step_name" AS "stepName",
                linked."kind",
                linked."status",
                linked."config",
                linked."context",
                linked."output",
                linked."error",
                linked."child_workflow_run_namespace_id" AS "childWorkflowRunNamespaceId",
                linked."child_workflow_run_id" AS "childWorkflowRunId",
                linked."started_at" AS "startedAt",
                linked."finished_at" AS "finishedAt",
                linked."created_at" AS "createdAt",
                linked."updated_at" AS "updatedAt",
                child."namespace_id" AS "childNamespaceId",
                child."id" AS "childId",
                child."workflow_name" AS "childWorkflowName",
                child."version" AS "childVersion",
                child."status" AS "childStatus",
                child."idempotency_key" AS "childIdempotencyKey",
                child."config" AS "childConfig",
                child."context" AS "childContext",
                child."input" AS "childInput",
                child."output" AS "childOutput",
                child."error" AS "childError",
                child."attempts" AS "childAttempts",
                child."parent_step_attempt_namespace_id" AS "childParentStepAttemptNamespaceId",
                child."parent_step_attempt_id" AS "childParentStepAttemptId",
                child."worker_id" AS "childWorkerId",
                child."available_at" AS "childAvailableAt",
                child."deadline_at" AS "childDeadlineAt",
                child."started_at" AS "childStartedAt",
                child."finished_at" AS "childFinishedAt",
                child."created_at" AS "childCreatedAt",
                child."updated_at" AS "childUpdatedAt"
            FROM linked, child
        `);
        const row = rows[0];
        if (!row) {
            throw new Error("Failed to add child workflow run");
        }
        return {
            stepAttempt: mapStepAttempt(row),
            workflowRun: mapWorkflowRun({
                namespaceId: row.childNamespaceId,
                id: row.childId,
                workflowName: row.childWorkflowName,
                version: row.childVersion,
                status: row.childStatus,
                idempotencyKey: row.childIdempotencyKey,
                config: row.childConfig,
                context: row.childContext,
                input: row.childInput,
                output: row.childOutput,
                error: row.childError,
                attempts: row.childAttempts,
                parentStepAttemptNamespaceId: row.childParentStepAttemptNamespaceId,
                parentStepAttemptId: row.childParentStepAttemptId,
                workerId: row.childWorkerId,
                availableAt: row.childAvailableAt,
                deadlineAt: row.childDeadlineAt,
                startedAt: row.childStartedAt,
                finishedAt: row.childFinishedAt,
                createdAt: row.childCreatedAt,
                updatedAt: row.childUpdatedAt,
            }),
        };
    }

    private async findWorkflowRunByIdempotencyKey(
        workflowName: string,
        idempotencyKey: string
    ): Promise<WorkflowRun | null> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            SELECT ${workflowRunColumns}
            FROM workflow_runs
            WHERE "namespace_id" = ${this.namespaceId}
              AND "workflow_name" = ${workflowName}
              AND "idempotency_key" = ${idempotencyKey}
            ORDER BY "created_at" DESC
            LIMIT 1
        `);
        return row ? mapWorkflowRun(row) : null;
    }

    private async reconcileWorkflowSleepWakeUp(workflowRunId: string): Promise<WorkflowRun | null> {
        const row = await this.runFirst<WorkflowRunRow>(sql`
            UPDATE workflow_runs wr
            SET "available_at" = CASE WHEN wr."available_at" IS NULL OR wr."available_at" > NOW() THEN NOW() ELSE wr."available_at" END,
                "updated_at" = NOW()
            WHERE wr."namespace_id" = ${this.namespaceId}
              AND wr."id" = ${workflowRunId}
              AND wr."status" = 'running'
              AND wr."worker_id" IS NULL
              AND (
                  EXISTS (
                      SELECT 1
                      FROM workflow_step_attempts sa
                      JOIN workflow_runs child
                        ON child."namespace_id" = sa."child_workflow_run_namespace_id"
                       AND child."id" = sa."child_workflow_run_id"
                      WHERE sa."namespace_id" = wr."namespace_id"
                        AND sa."workflow_run_id" = wr."id"
                        AND sa."kind" = 'workflow'
                        AND sa."status" = 'running'
                        AND child."status" IN ('completed', 'succeeded', 'failed', 'canceled')
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM workflow_step_attempts sa
                      JOIN workflow_signals ws
                        ON ws."namespace_id" = sa."namespace_id"
                       AND ws."step_attempt_id" = sa."id"
                      WHERE sa."namespace_id" = wr."namespace_id"
                        AND sa."workflow_run_id" = wr."id"
                        AND sa."kind" = 'signal-wait'
                        AND sa."status" = 'running'
                  )
              )
            RETURNING ${workflowRunColumns}
        `);
        return row ? mapWorkflowRun(row) : null;
    }

    private async wakeParentWorkflowRun(childWorkflowRun: Readonly<WorkflowRun>): Promise<void> {
        await this.runRows<{ id: string }>(sql`
            UPDATE workflow_runs wr
            SET "available_at" = CASE WHEN wr."available_at" IS NULL OR wr."available_at" > NOW() THEN NOW() ELSE wr."available_at" END,
                "updated_at" = NOW()
            FROM workflow_step_attempts sa
            WHERE sa."namespace_id" = ${this.namespaceId}
              AND sa."kind" = 'workflow'
              AND sa."status" = 'running'
              AND sa."child_workflow_run_namespace_id" = ${childWorkflowRun.namespaceId}
              AND sa."child_workflow_run_id" = ${childWorkflowRun.id}
              AND wr."namespace_id" = sa."namespace_id"
              AND wr."id" = sa."workflow_run_id"
              AND (wr."status" = 'sleeping' OR (wr."status" = 'running' AND wr."worker_id" IS NULL))
            RETURNING wr."id"
        `);
    }

    private runningWorkflowRunOwnedByWorkerWhere(params: Readonly<{ workflowRunId: string; workerId: string }>): SQL {
        return sql`
            "namespace_id" = ${this.namespaceId}
            AND "id" = ${params.workflowRunId}
            AND "status" = 'running'
            AND "worker_id" = ${params.workerId}
        `;
    }

    private runningStepAttemptOwnedByWorkerWhere(
        params: Readonly<{ workflowRunId: string; stepAttemptId: string; workerId: string }>
    ): SQL {
        return sql`
            sa."namespace_id" = ${this.namespaceId}
            AND sa."workflow_run_id" = ${params.workflowRunId}
            AND sa."id" = ${params.stepAttemptId}
            AND sa."status" = 'running'
            AND wr."namespace_id" = sa."namespace_id"
            AND wr."id" = sa."workflow_run_id"
            AND wr."status" = 'running'
            AND wr."worker_id" = ${params.workerId}
        `;
    }

    private async runRows<T>(query: SQL): Promise<T[]> {
        return runDatabaseEffect(tryDb((db) => Effect.map(db.execute(query), (result) => rows<T>(result))));
    }

    private async runFirst<T>(query: SQL): Promise<T | null> {
        return runDatabaseEffect(tryDb((db) => Effect.map(db.execute(query), (result) => maybeFirst<T>(result))));
    }
}

export const WorkflowBackend = DrizzleWorkflowBackend;

export class BackendPostgres extends DrizzleWorkflowBackend {
    static async connect(_url?: string, options?: DrizzleWorkflowBackendOptions): Promise<BackendPostgres> {
        return new BackendPostgres(options);
    }
}
