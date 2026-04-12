export type AICapability = "text" | "image" | "embedding" | "audio";

export type AIConcurrencyLimits = Record<AICapability, number>;

const DEFAULT_AI_CONCURRENCY_LIMIT = 64;

const defaultLimits: AIConcurrencyLimits = {
    text: DEFAULT_AI_CONCURRENCY_LIMIT,
    image: DEFAULT_AI_CONCURRENCY_LIMIT,
    embedding: DEFAULT_AI_CONCURRENCY_LIMIT,
    audio: DEFAULT_AI_CONCURRENCY_LIMIT,
};

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

function normalizeLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit) || !limit || limit < 1) {
        return DEFAULT_AI_CONCURRENCY_LIMIT;
    }

    return Math.floor(limit);
}

function createSemaphores(limits: Partial<AIConcurrencyLimits>): Record<AICapability, Semaphore> {
    return {
        text: new Semaphore(normalizeLimit(limits.text)),
        image: new Semaphore(normalizeLimit(limits.image)),
        embedding: new Semaphore(normalizeLimit(limits.embedding)),
        audio: new Semaphore(normalizeLimit(limits.audio)),
    };
}

let semaphores: Record<AICapability, Semaphore> | null = null;

export function configureAIConcurrency(limits: Partial<AIConcurrencyLimits>) {
    semaphores = createSemaphores({ ...defaultLimits, ...limits });
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
