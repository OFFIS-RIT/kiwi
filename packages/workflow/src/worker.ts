import { randomUUID } from "node:crypto";
import type { Backend } from "./backend";
import { computeBackoffDelayMs, resolveRetryPolicy } from "./core";
import type { RetryPolicy, Workflow, WorkflowLogger, WorkflowRun } from "./core";
import { executeWorkflow } from "./execution";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_BACKOFF_POLICY = {
    initialInterval: "100ms",
    backoffCoefficient: 2,
    maximumInterval: "1s",
} as const;

const MISSING_DEFINITION_RETRY_POLICY: RetryPolicy = {
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "5m",
    maximumAttempts: 0,
};

export interface WorkerOptions {
    readonly backend: Backend;
    readonly workflows: Workflow<unknown, unknown, unknown>[];
    readonly logger?: WorkflowLogger;
}

class WorkflowRegistry {
    private readonly workflows = new Map<string, Workflow<unknown, unknown, unknown>>();

    register(workflow: Workflow<unknown, unknown, unknown>): void {
        const version = workflow.spec.version ?? null;
        const key = registryKey(workflow.spec.name, version);
        if (this.workflows.has(key)) {
            const versionSuffix = version ? ` (version: ${version})` : "";
            throw new Error(`Workflow "${workflow.spec.name}"${versionSuffix} is already registered`);
        }
        this.workflows.set(key, workflow);
    }

    get(name: string, version: string | null): Workflow<unknown, unknown, unknown> | undefined {
        return this.workflows.get(registryKey(name, version));
    }

    getAll(): Workflow<unknown, unknown, unknown>[] {
        return [...this.workflows.values()];
    }
}

function registryKey(name: string, version: string | null): string {
    return version ? `${name}@${version}` : name;
}

function reportWorkerError(logger: WorkflowLogger | undefined, message: string, fields: Record<string, unknown>): void {
    if (!logger) {
        console.error(message, fields.error ?? fields);
        return;
    }

    try {
        logger.error(message, fields);
    } catch (loggerError) {
        console.error("Workflow logger failed:", loggerError);
    }
}

export class Worker {
    private readonly backend: Backend;
    private readonly logger: WorkflowLogger | undefined;
    private readonly workerId = randomUUID();
    private readonly registry = new WorkflowRegistry();
    private activeExecution: WorkflowExecution | null = null;
    private running = false;
    private loopPromise: Promise<void> | null = null;
    private backoffAttempts = 0;

    constructor(options: WorkerOptions) {
        this.backend = options.backend;
        this.logger = options.logger;
        for (const workflow of options.workflows) {
            this.registry.register(workflow);
        }
    }

    async start(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        this.backoffAttempts = 0;
        this.loopPromise = this.runLoop();
        await Promise.resolve();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.loopPromise) {
            await this.loopPromise;
        }
        while (this.activeExecution) {
            await sleep(100);
        }
    }

    async tick(): Promise<number> {
        if (this.activeExecution) {
            return 0;
        }
        const workflowRun = await this.backend.claimNextRunnableWorkflow({
            workerId: this.workerId,
            leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
        });
        if (!workflowRun) {
            return 0;
        }

        const workflow = this.registry.get(workflowRun.workflowName, workflowRun.version);
        if (!workflow) {
            const error = { message: `Workflow "${workflowRun.workflowName}" is not registered` };
            await this.backend.failClaimedWorkflow({
                workflowRunId: workflowRun.id,
                workerId: this.workerId,
                error,
                retryPolicy: MISSING_DEFINITION_RETRY_POLICY,
                attempts: workflowRun.attempts,
                deadlineAt: workflowRun.deadlineAt,
            });
            reportWorkerError(this.logger, "workflow run failed because its definition is missing", {
                workflowRunId: workflowRun.id,
                workflowName: workflowRun.workflowName,
                workflowVersion: workflowRun.version,
                workerId: this.workerId,
                serializedError: error,
            });
            return 0;
        }

        const execution = new WorkflowExecution({
            backend: this.backend,
            workerId: this.workerId,
            workflowRun,
            logger: this.logger,
        });
        this.activeExecution = execution;
        this.processExecution(execution, workflow)
            .catch((error: unknown) => {
                reportWorkerError(this.logger, "critical error during workflow execution", {
                    workflowRunId: workflowRun.id,
                    workflowName: workflowRun.workflowName,
                    workflowVersion: workflowRun.version,
                    workerId: this.workerId,
                    error,
                });
            })
            .finally(() => {
                execution.stopHeartbeat();
                if (this.activeExecution === execution) {
                    this.activeExecution = null;
                }
            });
        return 1;
    }

    private async runLoop(): Promise<void> {
        while (this.running) {
            try {
                const claimedCount = await this.tick();
                if (claimedCount > 0) {
                    this.backoffAttempts = 0;
                } else {
                    this.backoffAttempts += 1;
                    await sleep(getPollBackoffDelayMs(this.backoffAttempts));
                }
            } catch (error) {
                reportWorkerError(this.logger, "worker tick failed", { workerId: this.workerId, error });
                this.backoffAttempts += 1;
                await sleep(getPollBackoffDelayMs(this.backoffAttempts));
            }
        }
    }

    private async processExecution(
        execution: WorkflowExecution,
        workflow: Workflow<unknown, unknown, unknown>
    ): Promise<void> {
        execution.startHeartbeat();
        await executeWorkflow({
            backend: this.backend,
            workflowRun: execution.workflowRun,
            workflowFn: workflow.fn,
            workflowVersion: execution.workflowRun.version,
            workerId: execution.workerId,
            retryPolicy: resolveRetryPolicy(workflow.spec.retryPolicy),
            logger: this.logger,
        });
    }
}

class WorkflowExecution {
    private readonly backend: Backend;
    readonly workflowRun: WorkflowRun;
    readonly workerId: string;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;

    private readonly logger: WorkflowLogger | undefined;

    constructor(
        options: Readonly<{ backend: Backend; workflowRun: WorkflowRun; workerId: string; logger?: WorkflowLogger }>
    ) {
        this.backend = options.backend;
        this.workflowRun = options.workflowRun;
        this.workerId = options.workerId;
        this.logger = options.logger;
    }

    startHeartbeat(): void {
        this.stopped = false;
        const heartbeatIntervalMs = DEFAULT_LEASE_DURATION_MS / 2;
        this.heartbeatTimer = setInterval(() => {
            if (this.stopped) {
                return;
            }
            this.backend
                .heartbeatClaim({
                    workflowRunId: this.workflowRun.id,
                    workerId: this.workerId,
                    leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
                })
                .catch((error: unknown) => {
                    if (this.stopped || isLeaseExtensionLost(error)) {
                        this.stopHeartbeat();
                        return;
                    }
                    reportWorkerError(this.logger, "workflow heartbeat failed", {
                        workflowRunId: this.workflowRun.id,
                        workflowName: this.workflowRun.workflowName,
                        workflowVersion: this.workflowRun.version,
                        workerId: this.workerId,
                        error,
                    });
                });
        }, heartbeatIntervalMs);
    }

    stopHeartbeat(): void {
        this.stopped = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

function isLeaseExtensionLost(error: unknown): boolean {
    return error instanceof Error && error.message === "Failed to extend lease for workflow run";
}

function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

function getPollBackoffDelayMs(backoffAttempts: number): number {
    const cappedBackoffMs = computeBackoffDelayMs(DEFAULT_POLL_BACKOFF_POLICY, backoffAttempts);
    return Math.max(1, Math.round(cappedBackoffMs * (0.5 + Math.random() * 0.5)));
}
