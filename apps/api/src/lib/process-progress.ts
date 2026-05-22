import { FILE_PROCESS_STEP_VALUES, type FileProcessStep, type ProcessRunStatus } from "@kiwi/db/tables/graph";
import type { ApiBatchStepProgressLike } from "../types/routes";

type RunRow = {
    status: ProcessRunStatus;
};

type RunFile = {
    process_step: FileProcessStep;
};

export type StepProgress = {
    done: number;
    total: number;
};

export type DeleteProgress = {
    status: string;
    files: StepProgress;
    descriptions: StepProgress;
};

export function buildProcessStepProgress(
    run: RunRow,
    files: RunFile[],
    descriptionProgress?: StepProgress
): ApiBatchStepProgressLike | undefined {
    if (files.length === 0) {
        return undefined;
    }

    const total = files.length;
    if (run.status === "pending") {
        return {
            waiting_worker: `${total}/${total}`,
        };
    }

    const counts = Object.fromEntries(FILE_PROCESS_STEP_VALUES.map((step) => [step, 0])) as Record<
        FileProcessStep,
        number
    >;
    const progress: ApiBatchStepProgressLike = {};

    for (const file of files) {
        counts[file.process_step] += 1;
    }

    if (run.status === "started" && counts.completed === total) {
        if (descriptionProgress && descriptionProgress.total > 0) {
            return {
                describing: `${descriptionProgress.done}/${descriptionProgress.total}`,
            };
        }

        return {
            describing: `0/${total}`,
        };
    }

    for (const step of FILE_PROCESS_STEP_VALUES) {
        if (counts[step] > 0) {
            progress[step] = `${counts[step]}/${total}`;
        }
    }

    return Object.keys(progress).length > 0 ? progress : undefined;
}

export function buildDeleteStepProgress(progress: DeleteProgress): {
    process_step: ApiBatchStepProgressLike;
    process_percentage: number;
} {
    const processStep: ApiBatchStepProgressLike = {
        deleting: `${progress.files.done}/${progress.files.total}`,
    };

    if (progress.descriptions.total > 0) {
        processStep.describing = `${progress.descriptions.done}/${progress.descriptions.total}`;
    }

    const deletingRatio = progress.files.total > 0 ? progress.files.done / progress.files.total : 0;
    const descriptionRatio =
        progress.descriptions.total > 0 ? progress.descriptions.done / progress.descriptions.total : deletingRatio;
    const processPercentage =
        progress.descriptions.total > 0
            ? 5 + Math.round(Math.min(deletingRatio, 1) * 55 + Math.min(descriptionRatio, 1) * 35)
            : 5 + Math.round(Math.min(deletingRatio, 1) * 90);

    return {
        process_step: processStep,
        process_percentage: Math.max(5, Math.min(95, progress.status === "pending" ? 5 : processPercentage)),
    };
}
