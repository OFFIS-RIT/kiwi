import type { StepAttempt, StepAttemptContext } from "./core";

export const WORKFLOW_STEP_LIMIT = 1000;
export const STEP_LIMIT_EXCEEDED_ERROR_CODE = "STEP_LIMIT_EXCEEDED";

export class StepLimitExceededError extends Error {
    readonly code = STEP_LIMIT_EXCEEDED_ERROR_CODE;
    readonly limit: number;
    readonly stepCount: number;

    constructor(limit: number, stepCount: number) {
        super(`Exceeded the step limit of ${String(limit)} attempts (current count: ${String(stepCount)})`);
        this.name = "StepLimitExceededError";
        this.limit = limit;
        this.stepCount = stepCount;
    }
}

type StepAttemptCache = ReadonlyMap<string, StepAttempt>;

function createStepAttemptCacheFromAttempts(attempts: readonly StepAttempt[]): StepAttemptCache {
    return new Map(
        attempts
            .filter((attempt) => attempt.status === "completed" || attempt.status === "succeeded")
            .map((attempt) => [attempt.stepName, attempt])
    );
}

function addToStepAttemptCache(cache: StepAttemptCache, attempt: Readonly<StepAttempt>): StepAttemptCache {
    return new Map([...cache, [attempt.stepName, attempt as StepAttempt]]);
}

export function defaultWaitTimeoutAt(base: Readonly<Date> = new Date()): Date {
    const timeoutAt = new Date(base);
    timeoutAt.setFullYear(timeoutAt.getFullYear() + 1);
    return timeoutAt;
}

export function getContextTimeoutAt(attempt: Readonly<{ context: StepAttemptContext | null; createdAt: Date }>): Date | null {
    if (attempt.context?.kind !== "workflow" && attempt.context?.kind !== "signal-wait") {
        return null;
    }

    const timeoutAt = attempt.context.timeoutAt;
    if (timeoutAt === null) {
        return defaultWaitTimeoutAt(attempt.createdAt);
    }
    return new Date(timeoutAt);
}

function getRunningWaitAttemptResumeAt(attempt: Readonly<StepAttempt>): Date | null {
    if (attempt.status !== "running") {
        return null;
    }

    if (attempt.kind === "sleep" && attempt.context?.kind === "sleep") {
        const resumeAt = new Date(attempt.context.resumeAt);
        return Number.isFinite(resumeAt.getTime()) ? resumeAt : null;
    }

    if (attempt.kind !== "workflow" && attempt.kind !== "signal-wait") {
        return null;
    }

    const timeoutAt = getContextTimeoutAt(attempt) ?? defaultWaitTimeoutAt(attempt.createdAt);
    return Number.isFinite(timeoutAt.getTime()) ? timeoutAt : defaultWaitTimeoutAt(attempt.createdAt);
}

export class StepHistory {
    private cache: StepAttemptCache;
    private readonly failedCountsByStepName = new Map<string, number>();
    private readonly failedByStepName = new Map<string, StepAttempt>();
    private readonly runningByStepName = new Map<string, StepAttempt>();
    private readonly resolvedStepNames = new Set<string>();
    private readonly expectedNextStepIndexByName = new Map<string, number>();
    private readonly stepLimit: number;
    private stepCount: number;

    constructor(options: Readonly<{ attempts: readonly StepAttempt[]; stepLimit?: number }>) {
        this.stepLimit = Math.max(1, options.stepLimit ?? WORKFLOW_STEP_LIMIT);
        this.stepCount = options.attempts.length;
        this.cache = createStepAttemptCacheFromAttempts(options.attempts);

        for (const attempt of options.attempts) {
            if (attempt.status === "failed") {
                const previousCount = this.failedCountsByStepName.get(attempt.stepName) ?? 0;
                this.failedCountsByStepName.set(attempt.stepName, previousCount + 1);
                this.failedByStepName.set(attempt.stepName, attempt);
                continue;
            }

            if (attempt.status === "running") {
                this.runningByStepName.set(attempt.stepName, attempt);
            }
        }
    }

    resolveStepName(baseStepName: string): string {
        if (!this.resolvedStepNames.has(baseStepName)) {
            this.resolvedStepNames.add(baseStepName);
            return baseStepName;
        }

        const expectedNextIndex = this.expectedNextStepIndexByName.get(baseStepName) ?? 1;
        for (let index = expectedNextIndex; ; index += 1) {
            const resolvedName = `${baseStepName}:${String(index)}`;
            if (this.resolvedStepNames.has(resolvedName)) {
                continue;
            }

            this.expectedNextStepIndexByName.set(baseStepName, index + 1);
            this.resolvedStepNames.add(resolvedName);
            return resolvedName;
        }
    }

    findCached(stepName: string): StepAttempt | undefined {
        return this.cache.get(stepName);
    }

    findRunning(stepName: string): StepAttempt | undefined {
        return this.runningByStepName.get(stepName);
    }

    findTerminallyFailedWorkflow(stepName: string): StepAttempt | undefined {
        const attempt = this.failedByStepName.get(stepName);
        if (attempt?.kind === "workflow" && attempt.childWorkflowRunNamespaceId && attempt.childWorkflowRunId) {
            return attempt;
        }
        return undefined;
    }

    findConflictingSignalWait(signal: string, excludeStepName: string): { stepName: string; attempt: StepAttempt } | null {
        for (const [stepName, attempt] of this.runningByStepName) {
            if (
                stepName !== excludeStepName &&
                attempt.kind === "signal-wait" &&
                attempt.context?.kind === "signal-wait" &&
                attempt.context.signal === signal
            ) {
                return { stepName, attempt };
            }
        }
        return null;
    }

    failedAttemptCount(stepName: string): number {
        return this.failedCountsByStepName.get(stepName) ?? 0;
    }

    runningAttempts(): IterableIterator<StepAttempt> {
        return this.runningByStepName.values();
    }

    earliestRunningWaitResumeAt(): Date | null {
        let earliest: Date | null = null;
        for (const attempt of this.runningByStepName.values()) {
            const resumeAt = getRunningWaitAttemptResumeAt(attempt);
            if (!resumeAt) {
                continue;
            }
            if (!earliest || resumeAt.getTime() < earliest.getTime()) {
                earliest = resumeAt;
            }
        }
        return earliest;
    }

    resolveEarliestRunningWaitResumeAt(fallback: Readonly<Date>): Date {
        const earliest = this.earliestRunningWaitResumeAt();
        if (!earliest) {
            return new Date(fallback);
        }
        const fallbackMs = fallback.getTime();
        if (!Number.isFinite(fallbackMs)) {
            return earliest;
        }
        return earliest.getTime() < fallbackMs ? earliest : new Date(fallback);
    }

    ensureCanRecordNewAttempt(): void {
        if (this.stepCount >= this.stepLimit) {
            throw new StepLimitExceededError(this.stepLimit, this.stepCount);
        }
    }

    recordNewAttempt(attempt: Readonly<StepAttempt>): void {
        this.runningByStepName.set(attempt.stepName, attempt as StepAttempt);
        this.stepCount += 1;
    }

    replaceRunningAttempt(attempt: Readonly<StepAttempt>): void {
        this.runningByStepName.set(attempt.stepName, attempt as StepAttempt);
    }

    recordCompletion(attempt: Readonly<StepAttempt>): void {
        this.runningByStepName.delete(attempt.stepName);
        this.cache = addToStepAttemptCache(this.cache, attempt);
    }

    recordFailedAttempt(attempt: Readonly<StepAttempt>): number {
        this.runningByStepName.delete(attempt.stepName);
        const nextCount = (this.failedCountsByStepName.get(attempt.stepName) ?? 0) + 1;
        this.failedCountsByStepName.set(attempt.stepName, nextCount);
        this.failedByStepName.set(attempt.stepName, attempt as StepAttempt);
        return nextCount;
    }
}
