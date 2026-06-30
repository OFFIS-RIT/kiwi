import type { TimeoutConfiguration, ToolSet } from "ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const capabilities = ["text", "image", "embedding", "audio", "video"] as const;

export type AICapability = (typeof capabilities)[number];

export type AIConcurrencyLimits = Record<AICapability, number>;

const DEFAULT_AI_CONCURRENCY_LIMIT = 64;
export const AI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const AI_REQUEST_TIMEOUT = { totalMs: AI_REQUEST_TIMEOUT_MS } as const satisfies TimeoutConfiguration<ToolSet>;
const createSemaphore = (limit: number) => Semaphore.makeUnsafe(limit);
type AISemaphore = ReturnType<typeof createSemaphore>;

export class AiProviderError extends Schema.TaggedErrorClass<AiProviderError>()("AiProviderError", {
    capability: Schema.Literals(capabilities),
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

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

export const withAiSlotEffect: <T>(
    capability: AICapability,
    task: (signal: AbortSignal) => Promise<T>
) => Effect.Effect<T, AiProviderError> = Effect.fn("withAiSlotEffect")(function* <T>(
    capability: AICapability,
    task: (signal: AbortSignal) => Promise<T>
) {
    const runTask = Effect.tryPromise({
        try: task,
        catch: (cause) =>
            new AiProviderError({
                capability,
                message: `AI ${capability} request failed`,
                cause,
            }),
    });

    if (!semaphores) {
        return yield* runTask;
    }

    const semaphore = semaphores[capability];
    return yield* semaphore.withPermit(runTask);
});

export function withAiSlot<T>(capability: AICapability, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return Effect.runPromise(withAiSlotEffect(capability, task));
}
