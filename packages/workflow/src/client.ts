import type { Backend, SendSignalResult } from "./backend";
import { calculateDateFromDuration, defineWorkflow, validateInput } from "./core";
import type {
    DurationString,
    JsonValue,
    SchemaInput,
    SchemaOutput,
    StandardSchemaV1,
    Workflow,
    WorkflowFunction,
    WorkflowLogger,
    WorkflowSpec,
    WorkflowRun,
} from "./core";
import { Worker } from "./worker";

const DEFAULT_RESULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RESULT_TIMEOUT_MS = 5 * 60 * 1000;

type WorkflowHandlerInput<TSchema, Input> = SchemaOutput<TSchema, Input>;
type WorkflowRunInput<TSchema, Input> = SchemaInput<TSchema, Input>;

export interface WorkflowClientOptions {
    readonly backend: Backend;
    readonly logger?: WorkflowLogger;
}

export interface WorkflowRunOptions {
    readonly availableAt?: Date | DurationString;
    readonly deadlineAt?: Date;
    readonly idempotencyKey?: string;
}

export interface WorkflowRunHandleResultOptions {
    readonly timeoutMs?: number;
}

export interface WorkflowHandleOptions {
    readonly backend: Backend;
    readonly workflowRun: WorkflowRun;
    readonly resultPollIntervalMs: number;
    readonly resultTimeoutMs: number;
}

export class WorkflowClient {
    private readonly backend: Backend;
    private readonly logger: WorkflowLogger | undefined;
    private readonly registry = new WorkflowRegistry();

    constructor(options: WorkflowClientOptions) {
        this.backend = options.backend;
        this.logger = options.logger;
    }

    newWorker(): Worker {
        return new Worker({ backend: this.backend, workflows: this.registry.getAll(), logger: this.logger });
    }

    implementWorkflow<Input, Output, RunInput = Input>(
        spec: WorkflowSpec<Input, Output, RunInput>,
        fn: WorkflowFunction<Input, Output>
    ): void {
        this.registry.register({ spec, fn } as Workflow<unknown, unknown, unknown>);
    }

    async runWorkflow<Input, Output, RunInput = Input>(
        spec: WorkflowSpec<Input, Output, RunInput>,
        input?: RunInput,
        options?: WorkflowRunOptions
    ): Promise<WorkflowRunHandle<Output>> {
        const validationResult = await validateInput(spec.schema, input);
        if (!validationResult.success) {
            throw new Error(validationResult.error);
        }

        const workflowRun = await this.backend.startWorkflowRun({
            workflowName: spec.name,
            version: spec.version ?? null,
            idempotencyKey: options?.idempotencyKey ?? null,
            config: {},
            context: null,
            input: (validationResult.value ?? null) as JsonValue,
            availableAt: resolveAvailableAt(options?.availableAt),
            deadlineAt: options?.deadlineAt ?? null,
        });

        return new WorkflowRunHandle({
            backend: this.backend,
            workflowRun,
            resultPollIntervalMs: DEFAULT_RESULT_POLL_INTERVAL_MS,
            resultTimeoutMs: DEFAULT_RESULT_TIMEOUT_MS,
        });
    }

    defineWorkflow<Input, Output, TSchema extends StandardSchemaV1 | undefined = undefined>(
        spec: WorkflowSpec<WorkflowHandlerInput<TSchema, Input>, Output, WorkflowRunInput<TSchema, Input>>,
        fn: WorkflowFunction<WorkflowHandlerInput<TSchema, Input>, Output>
    ): RunnableWorkflow<WorkflowHandlerInput<TSchema, Input>, Output, WorkflowRunInput<TSchema, Input>> {
        const workflow = defineWorkflow(spec, fn);
        this.registry.register(workflow as Workflow<unknown, unknown, unknown>);
        return new RunnableWorkflow(this, workflow);
    }

    async cancelWorkflowRun(workflowRunId: string): Promise<void> {
        await this.backend.cancelWorkflowRun({ workflowRunId });
    }

    async sendSignal(
        options: Readonly<{ signal: string; data?: JsonValue; idempotencyKey?: string }>
    ): Promise<SendSignalResult> {
        return this.backend.deliverSignal({
            signal: options.signal,
            data: options.data ?? null,
            idempotencyKey: options.idempotencyKey ?? null,
        });
    }

    async addChildWorkflowRun<Input, Output, RunInput = Input>(
        parentWorkflowRunId: string,
        stepName: string,
        spec: WorkflowSpec<Input, Output, RunInput>,
        input?: RunInput
    ): Promise<WorkflowRunHandle<Output>> {
        const validationResult = await validateInput(spec.schema, input);
        if (!validationResult.success) {
            throw new Error(validationResult.error);
        }
        const result = await this.backend.startChildWorkflow({
            parentWorkflowRunId,
            stepName,
            workflowName: spec.name,
            version: spec.version ?? null,
            input: (validationResult.value ?? null) as JsonValue,
        });
        return new WorkflowRunHandle({
            backend: this.backend,
            workflowRun: result.workflowRun,
            resultPollIntervalMs: DEFAULT_RESULT_POLL_INTERVAL_MS,
            resultTimeoutMs: DEFAULT_RESULT_TIMEOUT_MS,
        });
    }
}

class RunnableWorkflow<Input, Output, RunInput = Input> {
    private readonly client: WorkflowClient;
    readonly workflow: Workflow<Input, Output, RunInput>;

    constructor(client: WorkflowClient, workflow: Workflow<Input, Output, RunInput>) {
        this.client = client;
        this.workflow = workflow;
    }

    async run(input?: RunInput, options?: WorkflowRunOptions): Promise<WorkflowRunHandle<Output>> {
        return this.client.runWorkflow(this.workflow.spec, input, options);
    }
}

export class WorkflowRunHandle<Output> {
    private readonly backend: Backend;
    readonly workflowRun: WorkflowRun;
    private readonly resultPollIntervalMs: number;
    private readonly resultTimeoutMs: number;

    constructor(options: WorkflowHandleOptions) {
        this.backend = options.backend;
        this.workflowRun = options.workflowRun;
        this.resultPollIntervalMs = options.resultPollIntervalMs;
        this.resultTimeoutMs = options.resultTimeoutMs;
    }

    async result(options?: WorkflowRunHandleResultOptions): Promise<Output> {
        const start = Date.now();
        const timeout = options?.timeoutMs ?? this.resultTimeoutMs;
        while (true) {
            const latest = await this.backend.getWorkflowRun({ workflowRunId: this.workflowRun.id });
            if (!latest) {
                throw new Error(`Workflow run ${this.workflowRun.id} no longer exists`);
            }
            if (Date.now() - start > timeout) {
                throw new Error(`Timed out waiting for workflow run ${this.workflowRun.id} to finish`);
            }
            if (latest.status === "succeeded" || latest.status === "completed") {
                return latest.output as Output;
            }
            if (latest.status === "failed") {
                throw new Error(`Workflow ${this.workflowRun.workflowName} failed: ${JSON.stringify(latest.error)}`);
            }
            if (latest.status === "canceled") {
                throw new Error(`Workflow ${this.workflowRun.workflowName} was canceled`);
            }
            await sleep(this.resultPollIntervalMs);
        }
    }

    async cancel(): Promise<void> {
        await this.backend.cancelWorkflowRun({ workflowRunId: this.workflowRun.id });
    }
}

class WorkflowRegistry {
    private readonly workflows = new Map<string, Workflow<unknown, unknown, unknown>>();

    register(workflow: Workflow<unknown, unknown, unknown>): void {
        const version = workflow.spec.version ?? null;
        const key = version ? `${workflow.spec.name}@${version}` : workflow.spec.name;
        if (this.workflows.has(key)) {
            throw new Error(`Workflow "${workflow.spec.name}" is already registered`);
        }
        this.workflows.set(key, workflow);
    }

    getAll(): Workflow<unknown, unknown, unknown>[] {
        return [...this.workflows.values()];
    }
}

function resolveAvailableAt(availableAt: Date | DurationString | undefined): Date | null {
    if (!availableAt) {
        return null;
    }
    if (availableAt instanceof Date) {
        return availableAt;
    }
    return calculateDateFromDuration(availableAt);
}

function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}
