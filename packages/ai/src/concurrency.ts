import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const capabilities = ["text", "image", "embedding", "audio", "video"] as const;

export type AICapability = (typeof capabilities)[number];

export type AIConcurrencyLimits = Record<AICapability, number>;

const DEFAULT_AI_CONCURRENCY_LIMIT = 64;

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

export function configureAIConcurrency(limits: Partial<AIConcurrencyLimits>) {
    semaphores = createSemaphores(limits);
}

export async function withAiSlot<T>(capability: AICapability, task: () => Promise<T>): Promise<T> {
    if (!semaphores) {
        return task();
    }

    const semaphore = semaphores[capability];
    await Effect.runPromise(semaphore.take(1));

    try {
        return await task();
    } finally {
        Effect.runSync(semaphore.release(1));
    }
}
