import type { ApiBatchStepProgress, ProcessStep } from "@/types";

function parseCount(value?: string): number {
    if (!value) return 0;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
}

function parseTotal(value?: string): number {
    if (!value) return 0;
    const total = value.split("/")[1];
    if (!total) return 0;

    const parsed = parseInt(total, 10);
    return isNaN(parsed) ? 0 : parsed;
}

/**
 * Determines the current process step based on the step with the highest file count.
 * Steps are aggregated as follows:
 * - waiting_worker -> waiting_worker (process run has not been claimed)
 * - pending -> queued (shown if no active processing steps)
 * - preprocessing + metadata + chunking -> processing_files
 * - extracting + deduplicating -> graph_creation
 * - saving -> saving
 * - describing -> generating_descriptions
 * - failed -> failed (only if majority)
 *
 * "Completed" is never shown. If only completed files remain, falls back to "saving".
 */
export function determineProcessStep(progress?: ApiBatchStepProgress): ProcessStep | undefined {
    if (!progress) return undefined;

    const waitingWorkerCount = parseCount(progress.waiting_worker);
    const queuedCount = parseCount(progress.pending);
    const processingFilesCount =
        parseCount(progress.preprocessing) + parseCount(progress.metadata) + parseCount(progress.chunking);
    const graphCreationCount = parseCount(progress.extracting) + parseCount(progress.deduplicating);
    const savingCount = parseCount(progress.saving);
    const describingCount = parseCount(progress.describing);
    const failedCount = parseCount(progress.failed);
    const completedCount = parseCount(progress.completed);
    const totalCount = Object.values(progress).reduce((maxTotal, value) => Math.max(maxTotal, parseTotal(value)), 0);
    const failedMajority = totalCount > 0 && failedCount > totalCount / 2;

    if (waitingWorkerCount > 0) {
        return "waiting_worker";
    }

    const activeStepCounts: { step: ProcessStep; count: number }[] = [
        { step: "generating_descriptions", count: describingCount },
        { step: "saving", count: savingCount },
        { step: "graph_creation", count: graphCreationCount },
        { step: "processing_files", count: processingFilesCount },
        { step: "failed", count: failedMajority ? failedCount : 0 },
    ];

    let maxStep: ProcessStep | undefined = undefined;
    let maxCount = 0;

    for (const { step, count } of activeStepCounts) {
        if (count > maxCount) {
            maxCount = count;
            maxStep = step;
        }
    }

    if (maxStep) {
        return maxStep;
    }

    if (queuedCount > 0) {
        return "queued";
    }

    if (completedCount > 0) {
        return "saving";
    }

    return undefined;
}
