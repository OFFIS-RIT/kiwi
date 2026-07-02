import type {
    WORKFLOW_RUN_STATUS_VALUES,
    STEP_ATTEMPT_STATUS_VALUES,
    STEP_KIND_VALUES,
} from "@kiwi/db/tables/workflow";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue | undefined } | readonly JsonValue[];

export type Years = "years" | "year" | "yrs" | "yr" | "y";
export type Months = "months" | "month" | "mo";
export type Weeks = "weeks" | "week" | "w";
export type Days = "days" | "day" | "d";
export type Hours = "hours" | "hour" | "hrs" | "hr" | "h";
export type Minutes = "minutes" | "minute" | "mins" | "min" | "m";
export type Seconds = "seconds" | "second" | "secs" | "sec" | "s";
export type Milliseconds = "milliseconds" | "millisecond" | "msecs" | "msec" | "ms";
export type DurationUnit = Years | Months | Weeks | Days | Hours | Minutes | Seconds | Milliseconds;
export type DurationUnitAnyCase = Capitalize<DurationUnit> | Uppercase<DurationUnit> | Lowercase<DurationUnit>;
export type DurationString = `${number}` | `${number}${DurationUnitAnyCase}` | `${number} ${DurationUnitAnyCase}`;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 2_629_800_000;
const YEAR_MS = 31_557_600_000;

const DURATION_MULTIPLIERS = {
    millisecond: 1,
    milliseconds: 1,
    msec: 1,
    msecs: 1,
    ms: 1,
    second: SECOND_MS,
    seconds: SECOND_MS,
    sec: SECOND_MS,
    secs: SECOND_MS,
    s: SECOND_MS,
    minute: MINUTE_MS,
    minutes: MINUTE_MS,
    min: MINUTE_MS,
    mins: MINUTE_MS,
    m: MINUTE_MS,
    hour: HOUR_MS,
    hours: HOUR_MS,
    hr: HOUR_MS,
    hrs: HOUR_MS,
    h: HOUR_MS,
    day: DAY_MS,
    days: DAY_MS,
    d: DAY_MS,
    week: WEEK_MS,
    weeks: WEEK_MS,
    w: WEEK_MS,
    month: MONTH_MS,
    months: MONTH_MS,
    mo: MONTH_MS,
    year: YEAR_MS,
    years: YEAR_MS,
    yr: YEAR_MS,
    yrs: YEAR_MS,
    y: YEAR_MS,
} satisfies Record<DurationUnit, number>;

const DURATION_REGEX = /^(-?\.?\d+(?:\.\d+)?)\s*([a-z]+)?$/i;

type ParseDurationResult =
    | { readonly ok: true; readonly value: number }
    | { readonly ok: false; readonly error: Error };

function isDurationUnit(value: string): value is DurationUnit {
    return value in DURATION_MULTIPLIERS;
}

export function parseDuration(value: DurationString): ParseDurationResult {
    const match = DURATION_REGEX.exec(value.trim());
    if (!match) {
        return { ok: false, error: new Error(`Invalid duration: ${value}`) };
    }

    const amount = Number.parseFloat(match[1] ?? "");
    if (!Number.isFinite(amount) || amount < 0) {
        return { ok: false, error: new Error(`Invalid duration: ${value}`) };
    }

    const unit = (match[2] ?? "ms").toLowerCase();
    if (!isDurationUnit(unit)) {
        return { ok: false, error: new Error(`Invalid duration unit: ${unit}`) };
    }

    return { ok: true, value: amount * DURATION_MULTIPLIERS[unit] };
}

export interface BackoffPolicy {
    readonly initialInterval: DurationString;
    readonly backoffCoefficient: number;
    readonly maximumInterval: DurationString;
}

export function computeBackoffDelayMs(policy: BackoffPolicy, attempt: number): number {
    const initial = parseDuration(policy.initialInterval);
    const maximum = parseDuration(policy.maximumInterval);
    const initialMs = initial.ok ? initial.value : 0;
    const maximumMs = maximum.ok ? maximum.value : 0;
    return Math.min(initialMs * policy.backoffCoefficient ** Math.max(0, attempt - 1), maximumMs);
}

export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
    readonly types?: StandardSchemaV1Types<Input, Output> | undefined;
}

export type StandardSchemaV1Result<Output> = StandardSchemaV1SuccessResult<Output> | StandardSchemaV1FailureResult;

export interface StandardSchemaV1SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
}

export interface StandardSchemaV1FailureResult {
    readonly issues: readonly StandardSchemaV1Issue[];
}

export interface StandardSchemaV1Issue {
    readonly message: string;
    readonly path?: readonly (PropertyKey | StandardSchemaV1PathSegment)[] | undefined;
}

export interface StandardSchemaV1PathSegment {
    readonly key: PropertyKey;
}

export interface StandardSchemaV1Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
}

export type StandardSchemaV1InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
>["input"];
export type StandardSchemaV1InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
>["output"];

export interface SerializedError {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
    readonly cause?: SerializedError;
    readonly [key: string]: JsonValue | undefined;
}

export interface WorkflowLogger {
    readonly error: (message: string, fields?: Record<string, unknown>) => void;
}

export function serializeError(error: unknown): SerializedError {
    return serializeErrorWithCauses(error, new WeakSet<object>());
}

function isPlainObject(value: object): value is Record<string, unknown> {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function toJsonSafeValue(value: unknown, seen: WeakSet<object>, depth = 0): JsonValue | undefined {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }

    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        return undefined;
    }

    if (typeof value !== "object" || seen.has(value) || depth >= 4) {
        return undefined;
    }

    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => toJsonSafeValue(item, seen, depth + 1) ?? null);
    }

    if (!isPlainObject(value)) {
        return undefined;
    }

    const entries = Object.entries(value)
        .map(([key, entryValue]) => [key, toJsonSafeValue(entryValue, seen, depth + 1)] as const)
        .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined);

    return Object.fromEntries(entries);
}

function jsonSafeErrorFields(error: Error, seen: WeakSet<object>): Record<string, JsonValue> {
    const fields: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(error)) {
        if (key === "name" || key === "message" || key === "stack" || key === "cause") {
            continue;
        }

        const serialized = toJsonSafeValue(value, seen);
        if (serialized !== undefined) {
            fields[key] = serialized;
        }
    }
    return fields;
}

function serializeErrorWithCauses(error: unknown, seen: WeakSet<object>): SerializedError {
    if (error && typeof error === "object") {
        if (seen.has(error)) {
            return { message: "[Circular error cause]" };
        }
        seen.add(error);
    }

    if (error instanceof Error) {
        const serialized = {
            ...(error.stack
                ? { name: error.name, message: error.message, stack: error.stack }
                : { name: error.name, message: error.message }),
            ...jsonSafeErrorFields(error, seen),
        };
        return "cause" in error && error.cause !== undefined
            ? { ...serialized, cause: serializeErrorWithCauses(error.cause, seen) }
            : serialized;
    }

    return { message: String(error) };
}

export function deserializeError(serialized: Readonly<SerializedError>): Error {
    const cause = serialized.cause ? deserializeError(serialized.cause) : undefined;
    const error = cause ? new Error(serialized.message, { cause }) : new Error(serialized.message);
    if (serialized.name) {
        error.name = serialized.name;
    }
    if (serialized.stack) {
        error.stack = serialized.stack;
    }
    return error;
}

export function requireRow<T>(row: T, operation: string): asserts row is NonNullable<T> {
    if (!row) {
        throw new Error(`Failed to ${operation}`);
    }
}

export type RetryPolicy = BackoffPolicy & Readonly<{ maximumAttempts: number }>;

export const DEFAULT_WORKFLOW_RETRY_POLICY: RetryPolicy = {
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "100s",
    maximumAttempts: 1,
};

export interface WorkflowSpec<Input, Output = unknown, RawInput = Input> {
    readonly name: string;
    readonly version?: string;
    readonly schema?: StandardSchemaV1<RawInput, Input>;
    readonly retryPolicy?: Partial<RetryPolicy>;
    readonly __types?: {
        readonly output: Output;
    };
}

export function defineWorkflowSpec<Input, Output = unknown, RawInput = Input>(
    spec: WorkflowSpec<Input, Output, RawInput>
): WorkflowSpec<Input, Output, RawInput> {
    return spec;
}

export const declareWorkflow = defineWorkflowSpec;

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUS_VALUES)[number];
export type StepAttemptStatus = (typeof STEP_ATTEMPT_STATUS_VALUES)[number];
export type StepKind = (typeof STEP_KIND_VALUES)[number];

export interface SleepStepAttemptContext {
    readonly kind: "sleep";
    readonly resumeAt: string;
}

export interface WorkflowStepAttemptContext {
    readonly kind: "workflow";
    readonly timeoutAt: string | null;
}

export interface SignalWaitStepAttemptContext {
    readonly kind: "signal-wait";
    readonly signal: string;
    readonly timeoutAt: string;
}

export type StepAttemptContext = SleepStepAttemptContext | WorkflowStepAttemptContext | SignalWaitStepAttemptContext;

export interface WorkflowRun {
    readonly namespaceId: string;
    readonly id: string;
    readonly workflowName: string;
    readonly version: string | null;
    readonly status: WorkflowRunStatus;
    readonly idempotencyKey: string | null;
    readonly config: JsonValue;
    readonly context: JsonValue | null;
    readonly input: JsonValue | null;
    readonly output: JsonValue | null;
    readonly error: SerializedError | null;
    readonly attempts: number;
    readonly parentStepAttemptNamespaceId: string | null;
    readonly parentStepAttemptId: string | null;
    readonly workerId: string | null;
    readonly availableAt: Date | null;
    readonly deadlineAt: Date | null;
    readonly startedAt: Date | null;
    readonly finishedAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export interface StepAttempt {
    readonly namespaceId: string;
    readonly id: string;
    readonly workflowRunId: string;
    readonly stepName: string;
    readonly kind: StepKind;
    readonly status: StepAttemptStatus;
    readonly config: JsonValue;
    readonly context: StepAttemptContext | null;
    readonly output: JsonValue | null;
    readonly error: SerializedError | null;
    readonly childWorkflowRunNamespaceId: string | null;
    readonly childWorkflowRunId: string | null;
    readonly startedAt: Date | null;
    readonly finishedAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export interface StepFunctionConfig {
    readonly name: string;
    readonly retryPolicy?: Partial<RetryPolicy>;
}

export type StepFunction<Output> = () => Promise<Output | undefined> | Output | undefined;
export type StepWaitTimeout = number | string | Date;

export interface StepRunWorkflowOptions {
    readonly name?: string;
    readonly timeout?: StepWaitTimeout;
}

export interface StepApi {
    readonly run: <Output>(config: Readonly<StepFunctionConfig>, fn: StepFunction<Output>) => Promise<Output>;
    readonly runWorkflow: <Input, Output, RunInput = Input>(
        spec: WorkflowSpec<Input, Output, RunInput>,
        input?: RunInput,
        options?: Readonly<StepRunWorkflowOptions>
    ) => Promise<Output>;
    readonly sleep: (name: string, duration: DurationString) => Promise<void>;
    readonly sendSignal: (options: Readonly<{ name?: string; signal: string; data?: JsonValue }>) => Promise<{
        workflowRunIds: string[];
    }>;
    readonly waitForSignal: <Output>(
        options: Readonly<{
            name?: string;
            signal: string;
            timeout?: StepWaitTimeout;
            schema?: StandardSchemaV1<unknown, Output>;
        }>
    ) => Promise<{ data: Output } | null>;
}

export interface WorkflowRetryState {
    readonly retryAttempt: number;
    readonly retryMaxAttempts: number;
    readonly retryTerminal: boolean;
}

export interface WorkflowRetryError extends Error, WorkflowRetryState {}

export type WorkflowRunMetadata = Pick<WorkflowRun, "id" | "workflowName" | "createdAt" | "startedAt"> &
    WorkflowRetryState;

export interface WorkflowFunctionParams<Input> {
    readonly input: Input;
    readonly step: StepApi;
    readonly version: string | null;
    readonly run: WorkflowRunMetadata;
}

export type WorkflowFunction<Input, Output> = (
    params: Readonly<WorkflowFunctionParams<Input>>
) => Promise<Output> | Output;

export interface Workflow<Input, Output, RawInput = Input> {
    readonly spec: WorkflowSpec<Input, Output, RawInput>;
    readonly fn: WorkflowFunction<Input, Output>;
}

export function defineWorkflow<Input, Output, RawInput = Input>(
    spec: WorkflowSpec<Input, Output, RawInput>,
    fn: WorkflowFunction<Input, Output>
): Workflow<Input, Output, RawInput> {
    return { spec, fn };
}

export function isWorkflow(value: unknown): value is Workflow<unknown, unknown, unknown> {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    const spec = candidate.spec as Record<string, unknown> | undefined;
    return (
        typeof spec === "object" && spec !== null && typeof spec.name === "string" && typeof candidate.fn === "function"
    );
}

export interface FailedWorkflowRunUpdate {
    readonly status: "pending" | "failed";
    readonly availableAt: Date | null;
    readonly finishedAt: Date | null;
    readonly error: SerializedError;
}

export function computeFailedWorkflowRunUpdate(
    retryPolicy: Readonly<RetryPolicy>,
    attempts: number,
    deadlineAt: Readonly<Date> | null,
    error: Readonly<SerializedError>,
    now: Readonly<Date>
): FailedWorkflowRunUpdate {
    const failed = (finalError: Readonly<SerializedError>): FailedWorkflowRunUpdate => ({
        status: "failed",
        availableAt: null,
        finishedAt: now,
        error: finalError,
    });

    if (deadlineAt && now >= deadlineAt) {
        return failed({ message: "Workflow run deadline exceeded" });
    }

    if (retryPolicy.maximumAttempts > 0 && attempts >= retryPolicy.maximumAttempts) {
        return failed(error);
    }

    const nextRetryAt = new Date(now.getTime() + computeBackoffDelayMs(retryPolicy, attempts));
    if (deadlineAt && nextRetryAt >= deadlineAt) {
        return failed(error);
    }

    return {
        status: "pending",
        availableAt: nextRetryAt,
        finishedAt: null,
        error,
    };
}

export function resolveRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
    if (!partial) {
        return DEFAULT_WORKFLOW_RETRY_POLICY;
    }
    const merged = { ...DEFAULT_WORKFLOW_RETRY_POLICY, ...partial };
    return {
        initialInterval: resolveDuration(merged.initialInterval, DEFAULT_WORKFLOW_RETRY_POLICY.initialInterval),
        backoffCoefficient:
            Number.isFinite(merged.backoffCoefficient) && merged.backoffCoefficient > 0
                ? merged.backoffCoefficient
                : DEFAULT_WORKFLOW_RETRY_POLICY.backoffCoefficient,
        maximumInterval: resolveDuration(merged.maximumInterval, DEFAULT_WORKFLOW_RETRY_POLICY.maximumInterval),
        maximumAttempts:
            Number.isInteger(merged.maximumAttempts) && merged.maximumAttempts >= 0
                ? merged.maximumAttempts
                : DEFAULT_WORKFLOW_RETRY_POLICY.maximumAttempts,
    };
}

function resolveDuration(value: DurationString, fallback: DurationString): DurationString {
    const parsed = parseDuration(value);
    return parsed.ok && parsed.value > 0 ? value : fallback;
}

export type SchemaInput<TSchema, Fallback> = TSchema extends StandardSchemaV1
    ? StandardSchemaV1InferInput<TSchema>
    : Fallback;
export type SchemaOutput<TSchema, Fallback> = TSchema extends StandardSchemaV1
    ? StandardSchemaV1InferOutput<TSchema>
    : Fallback;

export type ValidationResult<T> =
    | { readonly success: true; readonly value: T }
    | { readonly success: false; readonly error: string };

export async function validateInput<RunInput, Input>(
    schema: StandardSchemaV1<RunInput, Input> | null | undefined,
    input: RunInput | undefined
): Promise<ValidationResult<Input>> {
    if (!schema) {
        return { success: true, value: input as unknown as Input };
    }

    const result = await Promise.resolve(schema["~standard"].validate(input));
    if (result.issues) {
        const messages =
            result.issues.length > 0 ? result.issues.map((issue) => issue.message).join("; ") : "Validation failed";
        return { success: false, error: messages };
    }

    return { success: true, value: result.value };
}

export function isTerminalStatus(status: WorkflowRunStatus): boolean {
    return status === "completed" || status === "succeeded" || status === "failed" || status === "canceled";
}

export function normalizeStepOutput(result: unknown): JsonValue {
    return (result ?? null) as JsonValue;
}

export function calculateDateFromDuration(duration: DurationString, now = Date.now()): Date {
    const result = parseDuration(duration);
    if (!result.ok) {
        throw result.error;
    }
    return new Date(now + result.value);
}

export function createSleepContext(resumeAt: Readonly<Date>): StepAttemptContext {
    return { kind: "sleep", resumeAt: resumeAt.toISOString() };
}

export function createWorkflowContext(timeoutAt: Readonly<Date> | null): StepAttemptContext {
    return { kind: "workflow", timeoutAt: timeoutAt?.toISOString() ?? null };
}

export function createSignalWaitContext(signal: string, timeoutAt: Readonly<Date>): StepAttemptContext {
    return { kind: "signal-wait", signal, timeoutAt: timeoutAt.toISOString() };
}
