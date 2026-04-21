const capabilities = ["text", "image", "embedding", "audio"] as const;

export type AICapability = (typeof capabilities)[number];

export type AIConcurrencyLimits = Record<AICapability, number>;

const DEFAULT_AI_CONCURRENCY_LIMIT = 64;

class Semaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async acquire(): Promise<() => void> {
        if (this.active < this.limit) {
            this.active += 1;
            return () => this.release();
        }

        await new Promise<void>((resolve) => {
            this.queue.push(() => {
                this.active += 1;
                resolve();
            });
        });

        return () => this.release();
    }

    private release() {
        this.active -= 1;
        const next = this.queue.shift();

        if (next) {
            next();
        }
    }
}

function createSemaphores(limits: Partial<AIConcurrencyLimits>): Record<AICapability, Semaphore> {
    return Object.fromEntries(
        capabilities.map((capability) => {
            const limit = limits[capability];

            return [
                capability,
                new Semaphore(
                    !Number.isFinite(limit) || !limit || limit < 1
                        ? DEFAULT_AI_CONCURRENCY_LIMIT
                        : Math.floor(limit)
                ),
            ];
        })
    ) as Record<AICapability, Semaphore>;
}

let semaphores: Record<AICapability, Semaphore> | null = null;

export function configureAIConcurrency(limits: Partial<AIConcurrencyLimits>) {
    semaphores = createSemaphores(limits);
}

export async function withAiSlot<T>(capability: AICapability, task: () => Promise<T>): Promise<T> {
    if (!semaphores) {
        return task();
    }

    const release = await semaphores[capability].acquire();

    try {
        return await task();
    } finally {
        release();
    }
}
