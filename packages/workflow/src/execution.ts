import type { Backend } from "./backend";
import {
    calculateDateFromDuration,
    computeFailedWorkflowRunUpdate,
    createSignalWaitContext,
    createSleepContext,
    createWorkflowContext,
    DEFAULT_WORKFLOW_RETRY_POLICY,
    deserializeError,
    isTerminalStatus,
    normalizeStepOutput,
    resolveRetryPolicy,
    serializeError,
    type DurationString,
    type JsonValue,
    type RetryPolicy,
    type SerializedError,
    type StandardSchemaV1,
    type StepApi,
    type StepAttempt,
    type StepFunction,
    type StepFunctionConfig,
    type StepRunWorkflowOptions,
    type StepWaitTimeout,
    type WorkflowFunction,
    type WorkflowRun,
    type WorkflowSpec,
    validateInput,
} from "./core";
import {
    defaultWaitTimeoutAt,
    getContextTimeoutAt,
    StepHistory,
    StepLimitExceededError,
    WORKFLOW_STEP_LIMIT,
    STEP_LIMIT_EXCEEDED_ERROR_CODE,
} from "./history";

export { WORKFLOW_STEP_LIMIT, STEP_LIMIT_EXCEEDED_ERROR_CODE };

class SleepSignal extends Error {
    readonly resumeAt: Date;

    constructor(resumeAt: Readonly<Date>) {
        super("SleepSignal");
        this.name = "SleepSignal";
        this.resumeAt = new Date(resumeAt);
    }
}

class StaleExecutionBranchError extends Error {
    constructor() {
        super("Workflow execution branch is no longer active");
        this.name = "StaleExecutionBranchError";
    }
}

class ExecutionFence {
    private active = true;
    private parkedSleepSignal: SleepSignal | null = null;
    private readonly parkedDeferred = Promise.withResolvers<SleepSignal>();

    deactivate(): void {
        this.active = false;
    }

    parkOnSleep(signal: SleepSignal): void {
        const current = this.parkedSleepSignal;
        if (!current || signal.resumeAt.getTime() < current.resumeAt.getTime()) {
            this.parkedSleepSignal = signal;
            this.parkedDeferred.resolve(signal);
        }
        this.active = false;
    }

    get parked(): Promise<SleepSignal> {
        return this.parkedDeferred.promise;
    }

    assertActive(): void {
        if (this.active) {
            return;
        }
        if (this.parkedSleepSignal) {
            throw this.parkedSleepSignal;
        }
        throw new StaleExecutionBranchError();
    }
}

class StepError extends Error {
    readonly stepName: string;
    readonly stepFailedAttempts: number;
    readonly retryPolicy: RetryPolicy;
    readonly retryAttempt: number;
    readonly retryMaxAttempts: number;
    readonly retryTerminal: boolean;
    readonly originalError: unknown;

    constructor(options: Readonly<{ stepName: string; stepFailedAttempts: number; retryPolicy: RetryPolicy; error: unknown }>) {
        const serialized = serializeError(options.error);
        super(serialized.message, { cause: options.error });
        this.name = "StepError";
        this.stepName = options.stepName;
        this.stepFailedAttempts = options.stepFailedAttempts;
        this.retryPolicy = options.retryPolicy;
        this.retryAttempt = options.stepFailedAttempts;
        this.retryMaxAttempts = options.retryPolicy.maximumAttempts;
        this.retryTerminal = options.retryPolicy.maximumAttempts > 0 && options.stepFailedAttempts >= options.retryPolicy.maximumAttempts;
        this.originalError = options.error;
    }
}

const DEFAULT_STEP_RETRY_POLICY: RetryPolicy = {
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "100s",
    maximumAttempts: 10,
};

const TERMINAL_STEP_RETRY_POLICY: RetryPolicy = {
    ...DEFAULT_STEP_RETRY_POLICY,
    maximumAttempts: 1,
};

function resolveStepRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
    return partial ? { ...DEFAULT_STEP_RETRY_POLICY, ...partial } : DEFAULT_STEP_RETRY_POLICY;
}

function serializeStepLimitExceededError(error: Readonly<StepLimitExceededError>): SerializedError {
    return {
        name: error.name,
        message: error.message,
        code: error.code,
        limit: error.limit,
        stepCount: error.stepCount,
    } as SerializedError;
}

function resolveWaitTimeoutAt(timeout: StepWaitTimeout | undefined): Date {
    if (timeout === undefined) {
        return defaultWaitTimeoutAt();
    }
    if (timeout instanceof Date) {
        return timeout;
    }
    if (typeof timeout === "number") {
        if (!Number.isFinite(timeout) || timeout < 0) {
            throw new Error("Timeout must be a non-negative number");
        }
        return new Date(Date.now() + timeout);
    }
    return calculateDateFromDuration(timeout as DurationString);
}

function hasWorkflowTimedOut(attempt: Readonly<StepAttempt>, childRun: Readonly<WorkflowRun>): boolean {
    const timeoutAt = getContextTimeoutAt(attempt);
    if (!timeoutAt) {
        return false;
    }
    const timeoutMs = timeoutAt.getTime();
    if (!Number.isFinite(timeoutMs) || Date.now() < timeoutMs) {
        return false;
    }
    if (isTerminalStatus(childRun.status) && childRun.finishedAt) {
        return childRun.finishedAt.getTime() > timeoutMs;
    }
    return true;
}

async function listAllStepAttemptsForWorkflowRun(backend: Backend, workflowRunId: string): Promise<StepAttempt[]> {
    const attempts: StepAttempt[] = [];
    let after: string | undefined;
    do {
        const page = await backend.listStepAttempts({ workflowRunId, limit: 1000, after });
        attempts.push(...page.data);
        after = page.pagination.next ?? undefined;
    } while (after);
    return attempts;
}

async function executeWorkflowRunTransition(options: Readonly<{
    backend: Backend;
    workflowRunId: string;
    workerId: string;
    transition: () => Promise<unknown>;
}>): Promise<void> {
    try {
        await options.transition();
    } catch (error) {
        const currentRun = await options.backend.getWorkflowRun({ workflowRunId: options.workflowRunId });
        if (currentRun && (currentRun.status !== "running" || currentRun.workerId !== options.workerId)) {
            return;
        }
        throw error;
    }
}

async function completeElapsedRunningSleepAttempts(options: Readonly<{
    backend: Backend;
    workflowRunId: string;
    workerId: string;
    history: StepHistory;
}>): Promise<boolean> {
    let hasPendingRunningSleep = false;
    for (const attempt of [...options.history.runningAttempts()]) {
        if (attempt.kind !== "sleep" || attempt.context?.kind !== "sleep") {
            continue;
        }
        const resumeAt = new Date(attempt.context.resumeAt);
        const resumeAtMs = resumeAt.getTime();
        if (Number.isFinite(resumeAtMs) && Date.now() < resumeAtMs) {
            hasPendingRunningSleep = true;
            continue;
        }
        const completed = await options.backend.completeStepAttempt({
            workflowRunId: options.workflowRunId,
            stepAttemptId: attempt.id,
            workerId: options.workerId,
            output: null,
        });
        options.history.recordCompletion(completed);
    }
    return hasPendingRunningSleep;
}

class StepExecutor implements StepApi {
    private readonly backend: Backend;
    private readonly workflowRunId: string;
    private readonly workerId: string;
    private readonly history: StepHistory;
    private readonly executionFence: ExecutionFence;

    constructor(options: Readonly<{
        backend: Backend;
        workflowRunId: string;
        workerId: string;
        history: StepHistory;
        executionFence: ExecutionFence;
    }>) {
        this.backend = options.backend;
        this.workflowRunId = options.workflowRunId;
        this.workerId = options.workerId;
        this.history = options.history;
        this.executionFence = options.executionFence;
    }

    private createStepAttempt = async (
        stepName: string,
        kind: StepAttempt["kind"],
        config: JsonValue,
        context: StepAttempt["context"]
    ): Promise<StepAttempt> => {
        this.executionFence.assertActive();
        this.history.ensureCanRecordNewAttempt();
        const attempt = await this.backend.createStepAttempt({
            workflowRunId: this.workflowRunId,
            workerId: this.workerId,
            stepName,
            kind,
            config,
            context,
        });
        this.history.recordNewAttempt(attempt);
        return attempt;
    };

    private completeStepAttemptAndRecord = async (stepAttemptId: string, output: JsonValue | null): Promise<StepAttempt> => {
        this.executionFence.assertActive();
        const completed = await this.backend.completeStepAttempt({
            workflowRunId: this.workflowRunId,
            stepAttemptId,
            workerId: this.workerId,
            output,
        });
        this.history.recordCompletion(completed);
        return completed;
    };

    private failStepAttemptAndThrow = async (attempt: Readonly<StepAttempt>, retryPolicy: RetryPolicy, error: unknown): Promise<never> => {
        const failed = await this.backend.failStepAttempt({
            workflowRunId: this.workflowRunId,
            stepAttemptId: attempt.id,
            workerId: this.workerId,
            error: serializeError(error),
        });
        const stepFailedAttempts = this.history.recordFailedAttempt(failed);
        throw new StepError({ stepName: attempt.stepName, stepFailedAttempts, retryPolicy, error });
    };

    async run<Output>(config: Readonly<StepFunctionConfig>, fn: StepFunction<Output>): Promise<Output> {
        const stepName = this.history.resolveStepName(config.name);
        const cached = this.history.findCached(stepName);
        if (cached) {
            return cached.output as Output;
        }
        if (this.history.findRunning(stepName)) {
            throw new Error(`Step ${stepName} is already running`);
        }

        const retryPolicy = resolveStepRetryPolicy(config.retryPolicy);
        const attempt = await this.createStepAttempt(stepName, "function", config as unknown as JsonValue, null);
        try {
            const result = await fn();
            const savedAttempt = await this.completeStepAttemptAndRecord(attempt.id, normalizeStepOutput(result));
            return savedAttempt.output as Output;
        } catch (error) {
            return await this.failStepAttemptAndThrow(attempt, retryPolicy, error);
        }
    }

    async sleep(name: string, duration: DurationString): Promise<void> {
        const stepName = this.history.resolveStepName(name);
        if (this.history.findCached(stepName)) {
            return;
        }
        const running = this.history.findRunning(stepName);
        if (running) {
            if (running.kind === "sleep" && running.context?.kind === "sleep") {
                const resumeAt = new Date(running.context.resumeAt);
                if (Date.now() >= resumeAt.getTime()) {
                    await this.completeStepAttemptAndRecord(running.id, null);
                    return;
                }
                return await this.park(resumeAt);
            }
            throw new Error(`Step ${stepName} is already running`);
        }
        const resumeAt = calculateDateFromDuration(duration);
        await this.createStepAttempt(stepName, "sleep", {}, createSleepContext(resumeAt));
        return await this.park(this.history.resolveEarliestRunningWaitResumeAt(resumeAt));
    }

    async runWorkflow<Input, Output, RunInput = Input>(
        spec: WorkflowSpec<Input, Output, RunInput>,
        input?: RunInput,
        options?: Readonly<StepRunWorkflowOptions>
    ): Promise<Output> {
        const stepName = this.history.resolveStepName(options?.name ?? spec.name);
        const cached = this.history.findCached(stepName);
        if (cached) {
            return cached.output as Output;
        }
        const failed = this.history.findTerminallyFailedWorkflow(stepName);
        if (failed) {
            throw deserializeError(failed.error ?? { message: `Child workflow ${spec.name} failed` });
        }
        const running = this.history.findRunning(stepName);
        if (running) {
            return await this.resolveRunningWorkflowAttempt<Output>(running);
        }

        const timeoutAt = resolveWaitTimeoutAt(options?.timeout);
        const attempt = await this.createStepAttempt(stepName, "workflow", {}, createWorkflowContext(timeoutAt));
        const childRun = await this.createChildWorkflowRun(spec, input, attempt);
        const linked = await this.backend.setStepAttemptChildWorkflowRun({
            workflowRunId: this.workflowRunId,
            stepAttemptId: attempt.id,
            workerId: this.workerId,
            childWorkflowRunNamespaceId: childRun.namespaceId,
            childWorkflowRunId: childRun.id,
        });
        this.history.replaceRunningAttempt(linked);
        return await this.resolveRunningWorkflowAttempt<Output>(linked);
    }

    async sendSignal(options: Readonly<{ name?: string; signal: string; data?: JsonValue }>): Promise<{ workflowRunIds: string[] }> {
        const stepName = this.history.resolveStepName(options.name ?? `signal-send:${options.signal}`);
        const cached = this.history.findCached(stepName);
        if (cached) {
            return cached.output as { workflowRunIds: string[] };
        }
        const attempt = await this.createStepAttempt(stepName, "signal-send", { signal: options.signal }, null);
        try {
            const result = await this.backend.sendSignal({ signal: options.signal, data: options.data ?? null, idempotencyKey: attempt.id });
            const completed = await this.completeStepAttemptAndRecord(attempt.id, result as unknown as JsonValue);
            return completed.output as { workflowRunIds: string[] };
        } catch (error) {
            return await this.failStepAttemptAndThrow(attempt, TERMINAL_STEP_RETRY_POLICY, error);
        }
    }

    async waitForSignal<Output>(
        options: Readonly<{ name?: string; signal: string; timeout?: StepWaitTimeout; schema?: StandardSchemaV1<unknown, Output> }>
    ): Promise<{ data: Output } | null> {
        const stepName = this.history.resolveStepName(options.name ?? `signal-wait:${options.signal}`);
        const cached = this.history.findCached(stepName);
        if (cached) {
            return cached.output as { data: Output } | null;
        }
        const running = this.history.findRunning(stepName);
        if (running) {
            return await this.resolveRunningSignalWaitAttempt(running, options.schema);
        }
        const conflict = this.history.findConflictingSignalWait(options.signal, stepName);
        if (conflict) {
            throw new Error(`Signal ${options.signal} is already being waited on by step ${conflict.stepName}`);
        }
        const timeoutAt = resolveWaitTimeoutAt(options.timeout);
        const attempt = await this.createStepAttempt(
            stepName,
            "signal-wait",
            { signal: options.signal },
            createSignalWaitContext(options.signal, timeoutAt)
        );
        return await this.resolveRunningSignalWaitAttempt(attempt, options.schema);
    }

    private async createChildWorkflowRun<Input, Output, RunInput>(
        spec: WorkflowSpec<Input, Output, RunInput>,
        input: RunInput | undefined,
        attempt: Readonly<StepAttempt>
    ): Promise<WorkflowRun> {
        const validationResult = await validateInput(spec.schema, input);
        if (!validationResult.success) {
            throw new Error(validationResult.error);
        }
        return this.backend.createWorkflowRun({
            workflowName: spec.name,
            version: spec.version ?? null,
            idempotencyKey: `__workflow:${attempt.namespaceId}:${attempt.id}`,
            config: {},
            context: null,
            input: (validationResult.value ?? null) as JsonValue,
            parentStepAttemptNamespaceId: attempt.namespaceId,
            parentStepAttemptId: attempt.id,
            availableAt: null,
            deadlineAt: null,
        });
    }

    resolveExternalWorkflowAttempt(attempt: Readonly<StepAttempt>): Promise<unknown> {
        return this.resolveRunningWorkflowAttempt(attempt);
    }

    private async resolveRunningWorkflowAttempt<Output>(attempt: Readonly<StepAttempt>): Promise<Output> {
        if (!attempt.childWorkflowRunId) {
            return await this.park(this.history.resolveEarliestRunningWaitResumeAt(defaultWaitTimeoutAt(attempt.createdAt)));
        }
        const childRun = await this.backend.getWorkflowRun({ workflowRunId: attempt.childWorkflowRunId! });
        if (!childRun) {
            return await this.failStepAttemptAndThrow(attempt, TERMINAL_STEP_RETRY_POLICY, new Error("Child workflow run not found"));
        }
        if (childRun.status === "completed" || childRun.status === "succeeded") {
            const completed = await this.completeStepAttemptAndRecord(attempt.id, childRun.output);
            return completed.output as Output;
        }
        if (childRun.status === "failed") {
            return await this.failStepAttemptAndThrow(
                attempt,
                TERMINAL_STEP_RETRY_POLICY,
                deserializeError(childRun.error ?? { message: `Child workflow ${childRun.workflowName} failed` })
            );
        }
        if (childRun.status === "canceled") {
            return await this.failStepAttemptAndThrow(
                attempt,
                TERMINAL_STEP_RETRY_POLICY,
                new Error(`Child workflow ${childRun.workflowName} was canceled`)
            );
        }
        if (hasWorkflowTimedOut(attempt, childRun)) {
            return await this.failStepAttemptAndThrow(
                attempt,
                TERMINAL_STEP_RETRY_POLICY,
                new Error(`Child workflow ${childRun.workflowName} timed out`)
            );
        }
        const timeoutAt = getContextTimeoutAt(attempt) ?? defaultWaitTimeoutAt(attempt.createdAt);
        return await this.park(this.history.resolveEarliestRunningWaitResumeAt(timeoutAt));
    }

    private async resolveRunningSignalWaitAttempt<Output>(
        attempt: Readonly<StepAttempt>,
        schema: StandardSchemaV1<unknown, Output> | undefined
    ): Promise<{ data: Output } | null> {
        if (attempt.context?.kind !== "signal-wait") {
            throw new Error(`Step ${attempt.stepName} is not a signal wait`);
        }
        const delivered = await this.backend.getSignalDelivery({ stepAttemptId: attempt.id });
        if (delivered !== undefined) {
            const validationResult = await validateInput(schema, delivered);
            if (!validationResult.success) {
                return await this.failStepAttemptAndThrow(attempt, TERMINAL_STEP_RETRY_POLICY, new Error(validationResult.error));
            }
            const completed = await this.completeStepAttemptAndRecord(attempt.id, { data: validationResult.value } as JsonValue);
            return completed.output as { data: Output } | null;
        }
        const timeoutAt = new Date(attempt.context.timeoutAt);
        if (Date.now() >= timeoutAt.getTime()) {
            const completed = await this.completeStepAttemptAndRecord(attempt.id, null);
            return completed.output as { data: Output } | null;
        }
        return await this.park(this.history.resolveEarliestRunningWaitResumeAt(timeoutAt));
    }

    private park(resumeAt: Readonly<Date>): Promise<never> {
        const signal = new SleepSignal(resumeAt);
        this.executionFence.parkOnSleep(signal);
        return new Promise<never>(() => {});
    }
}

async function resolveRunningWaitAttempts(options: Readonly<{
    backend: Backend;
    workflowRunId: string;
    workerId: string;
    history: StepHistory;
    executor: StepExecutor;
}>): Promise<void> {
    const hasPendingRunningSleep = await completeElapsedRunningSleepAttempts(options);
    if (hasPendingRunningSleep) {
        const earliestResumeAt = options.history.earliestRunningWaitResumeAt();
        if (earliestResumeAt && Date.now() < earliestResumeAt.getTime()) {
            throw new SleepSignal(earliestResumeAt);
        }
    }

    for (const attempt of [...options.history.runningAttempts()]) {
        const config = attempt.config as { external?: unknown };
        if (attempt.kind === "workflow" && config.external === true) {
            await options.executor.resolveExternalWorkflowAttempt(attempt);
        }
    }
}

export interface ExecuteWorkflowParams {
    readonly backend: Backend;
    readonly workflowRun: WorkflowRun;
    readonly workflowFn: WorkflowFunction<unknown, unknown>;
    readonly workflowVersion: string | null;
    readonly workerId: string;
    readonly retryPolicy: RetryPolicy;
}

export async function executeWorkflow(params: Readonly<ExecuteWorkflowParams>): Promise<void> {
    const { backend, workflowRun, workflowFn, workflowVersion, workerId } = params;
    const executionFence = new ExecutionFence();

    const runTransition = (transition: () => Promise<unknown>): Promise<void> =>
        executeWorkflowRunTransition({ backend, workflowRunId: workflowRun.id, workerId, transition });

    const failRun = (error: SerializedError, retryPolicy: RetryPolicy): Promise<void> =>
        runTransition(() =>
            backend.failWorkflowRun({
                workflowRunId: workflowRun.id,
                workerId,
                error,
                retryPolicy,
                attempts: workflowRun.attempts,
                deadlineAt: workflowRun.deadlineAt,
            })
        );

    try {
        const attempts = await listAllStepAttemptsForWorkflowRun(backend, workflowRun.id);
        const history = new StepHistory({ attempts });
        const executor = new StepExecutor({ backend, workflowRunId: workflowRun.id, workerId, history, executionFence });

        await resolveRunningWaitAttempts({ backend, workflowRunId: workflowRun.id, workerId, history, executor });

        const retryMaxAttempts = params.retryPolicy.maximumAttempts;
        const run = Object.freeze({
            id: workflowRun.id,
            workflowName: workflowRun.workflowName,
            createdAt: workflowRun.createdAt,
            startedAt: workflowRun.startedAt,
            retryAttempt: workflowRun.attempts,
            retryMaxAttempts,
            retryTerminal: retryMaxAttempts > 0 && workflowRun.attempts >= retryMaxAttempts,
        });

        const output = await Promise.race([
            workflowFn({
                input: workflowRun.input,
                step: executor,
                version: workflowVersion,
                run,
            }),
            executionFence.parked.then((signal) => {
                throw signal;
            }),
        ]);

        const finalAttempts = await listAllStepAttemptsForWorkflowRun(backend, workflowRun.id);
        const finalHistory = new StepHistory({ attempts: finalAttempts });
        const finalExecutor = new StepExecutor({ backend, workflowRunId: workflowRun.id, workerId, history: finalHistory, executionFence });
        await resolveRunningWaitAttempts({ backend, workflowRunId: workflowRun.id, workerId, history: finalHistory, executor: finalExecutor });

        executionFence.deactivate();
        await runTransition(() =>
            backend.completeWorkflowRun({ workflowRunId: workflowRun.id, workerId, output: (output ?? null) as JsonValue })
        );
    } catch (error) {
        executionFence.deactivate();
        if (error instanceof SleepSignal) {
            await runTransition(() => backend.sleepWorkflowRun({ workflowRunId: workflowRun.id, workerId, availableAt: error.resumeAt }));
            return;
        }
        if (error instanceof StepLimitExceededError) {
            await failRun(serializeStepLimitExceededError(error), DEFAULT_WORKFLOW_RETRY_POLICY);
            return;
        }
        if (error instanceof StepError) {
            const serializedError = serializeError(error.originalError);
            const retryDecision = computeFailedWorkflowRunUpdate(error.retryPolicy, error.stepFailedAttempts, workflowRun.deadlineAt, serializedError, new Date());
            if (retryDecision.status === "failed") {
                await failRun(serializedError, DEFAULT_WORKFLOW_RETRY_POLICY);
                return;
            }
            if (!retryDecision.availableAt) {
                throw new Error("Step retry decision missing availableAt");
            }
            await runTransition(() =>
                backend.rescheduleWorkflowRunAfterFailedStepAttempt({
                    workflowRunId: workflowRun.id,
                    workerId,
                    error: serializedError,
                    availableAt: retryDecision.availableAt!,
                })
            );
            return;
        }
        if (error instanceof StaleExecutionBranchError) {
            return;
        }
        await failRun(serializeError(error), params.retryPolicy);
    }
}
