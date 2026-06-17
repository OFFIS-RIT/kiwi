import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Semaphore from "effect/Semaphore";

const capabilities = ["text", "image", "embedding", "audio", "video"] as const;

export type AICapability = (typeof capabilities)[number];

export type AIConcurrencyLimits = Record<AICapability, number>;

const DEFAULT_AI_CONCURRENCY_LIMIT = 64;
const DEFAULT_AI_REQUEST_TIMEOUT: Duration.Input = "10 minutes";
const createSemaphore = (limit: number) => Semaphore.makeUnsafe(limit);
type AISemaphore = ReturnType<typeof createSemaphore>;

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

export function configureAIConcurrency(limits: Partial<AIConcurrencyLimits>, options: { requestTimeout?: Duration.Input } = {}) {
    semaphores = createSemaphores(limits);
    requestTimeout = options.requestTimeout ?? DEFAULT_AI_REQUEST_TIMEOUT;
}

export function withAiSlot<T>(
    capability: AICapability,
    task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    const runTask = Effect.tryPromise(task).pipe(Effect.timeout(requestTimeout));

    if (!semaphores) {
        return Effect.runPromise(runTask);
    }

    const semaphore = semaphores[capability];
    return Effect.runPromise(
        Effect.acquireUseRelease(
            semaphore.take(1),
            () => runTask,
            () => semaphore.release(1)
        )
    );
}
