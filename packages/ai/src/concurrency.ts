import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Duration from "effect/Duration";
import * as Semaphore from "effect/Semaphore";

const capabilities = ["text", "image", "embedding", "audio", "video"] as const;

export type AICapability = (typeof capabilities)[number];

export type AIConcurrencyLimits = Record<AICapability, number>;

const DEFAULT_AI_CONCURRENCY_LIMIT = 64;
const DEFAULT_AI_REQUEST_TIMEOUT: Duration.Input = "10 minutes";
const DEFAULT_AI_REQUEST_TIMEOUT_LABEL = "10 minutes";
const createSemaphore = (limit: number) => Semaphore.makeUnsafe(limit);
type AISemaphore = ReturnType<typeof createSemaphore>;

export class AiProviderError extends Schema.TaggedErrorClass<AiProviderError>()("AiProviderError", {
    capability: Schema.Literals(capabilities),
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

export class AiRequestTimeoutError extends Schema.TaggedErrorClass<AiRequestTimeoutError>()("AiRequestTimeoutError", {
    capability: Schema.Literals(capabilities),
    message: Schema.String,
    timeout: Schema.String,
}) {}

export type AiSlotError = AiProviderError | AiRequestTimeoutError;

function normalizeLimit(limit: number | undefined): number {
    return !Number.isFinite(limit) || !limit || limit < 1 ? DEFAULT_AI_CONCURRENCY_LIMIT : Math.floor(limit);
}

function createSemaphores(limits: Partial<AIConcurrencyLimits>): Record<AICapability, AISemaphore> {
    return Object.fromEntries(
        capabilities.map((capability) => [capability, createSemaphore(normalizeLimit(limits[capability]))])
    ) as Record<AICapability, AISemaphore>;
}

let semaphores: Record<AICapability, AISemaphore> | null = null;
let requestTimeout: Duration.Input = DEFAULT_AI_REQUEST_TIMEOUT;

export function configureAIConcurrency(
    limits: Partial<AIConcurrencyLimits>,
    options: { requestTimeout?: Duration.Input } = {}
) {
    semaphores = createSemaphores(limits);
    requestTimeout = options.requestTimeout ?? DEFAULT_AI_REQUEST_TIMEOUT;
}

function describeTimeout(timeout: Duration.Input): string {
    return typeof timeout === "string" ? timeout : DEFAULT_AI_REQUEST_TIMEOUT_LABEL;
}

function isEffectTimeout(error: unknown): boolean {
    return typeof error === "object" && error !== null && "_tag" in error && error._tag === "TimeoutException";
}

export const withAiSlotEffect: <T>(
    capability: AICapability,
    task: (signal: AbortSignal) => Promise<T>
) => Effect.Effect<T, AiSlotError> = Effect.fn("withAiSlotEffect")(function* <T>(
    capability: AICapability,
    task: (signal: AbortSignal) => Promise<T>
) {
    const timeout = requestTimeout;
    const timeoutLabel = describeTimeout(timeout);
    const runTask = Effect.tryPromise({
        try: task,
        catch: (cause) =>
            new AiProviderError({
                capability,
                message: `AI ${capability} request failed`,
                cause,
            }),
    }).pipe(
        Effect.timeout(timeout),
        Effect.mapError((error) =>
            isEffectTimeout(error)
                ? new AiRequestTimeoutError({
                      capability,
                      message: `AI ${capability} request timed out after ${timeoutLabel}`,
                      timeout: timeoutLabel,
                  })
                : (error as AiProviderError)
        )
    );

    if (!semaphores) {
        return yield* runTask;
    }

    const semaphore = semaphores[capability];
    return yield* Effect.acquireUseRelease(
        semaphore.take(1),
        () => runTask,
        () => semaphore.release(1)
    );
});

export function withAiSlot<T>(capability: AICapability, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return Effect.runPromise(withAiSlotEffect(capability, task));
}
