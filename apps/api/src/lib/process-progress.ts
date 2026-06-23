import { FILE_PROCESS_STEP_VALUES, type FileProcessStep, type ProcessRunStatus } from "@kiwi/db/tables/graph";
import type { ApiBatchStepProgressLike } from "../types/routes";

const FILE_STEP_PROGRESS: Record<FileProcessStep, number> = {
    pending: 0,
    preprocessing: 10,
    metadata: 25,
    chunking: 40,
    extracting: 60,
    deduplicating: 75,
    saving: 90,
    completed: 100,
    failed: 100,
};

const PROCESS_FILE_PHASE_PERCENTAGE = 90;
const PROCESS_DESCRIPTION_PHASE_PERCENTAGE = 100 - PROCESS_FILE_PHASE_PERCENTAGE;
const MAX_ACTIVE_PROCESS_PERCENTAGE = 99;

type RunRow = {
    status: ProcessRunStatus;
};

type RunFile = {
    process_step: FileProcessStep;
};

export type EstimatedRunFile = RunFile & {
    estimated_duration: number;
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

function clampRatio(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(1, value));
}

function descriptionRatio(descriptionProgress?: StepProgress) {
    if (!descriptionProgress || descriptionProgress.total <= 0) {
        return 0;
    }

    return clampRatio(descriptionProgress.done / descriptionProgress.total);
}

function formatStepProgress(progress: StepProgress) {
    const total = Math.max(0, progress.total);
    const done = Math.max(0, Math.min(progress.done, total));
    return `${done}/${total}`;
}

function fileStepProgress(step: FileProcessStep) {
    return FILE_STEP_PROGRESS[step];
}

export function buildProcessPercentage(files: RunFile[], descriptionProgress?: StepProgress): number {
    if (files.length === 0) {
        return 0;
    }

    const totalProgress = files.reduce((sum, file) => sum + fileStepProgress(file.process_step), 0);
    const fileProgressPercentage = totalProgress / files.length;
    const filePhasePercentage = Math.round(fileProgressPercentage * (PROCESS_FILE_PHASE_PERCENTAGE / 100));

    if (fileProgressPercentage < 100) {
        return Math.max(0, Math.min(PROCESS_FILE_PHASE_PERCENTAGE, filePhasePercentage));
    }

    if (!descriptionProgress || descriptionProgress.total <= 0) {
        return PROCESS_FILE_PHASE_PERCENTAGE;
    }

    const percentage =
        PROCESS_FILE_PHASE_PERCENTAGE +
        Math.round(descriptionRatio(descriptionProgress) * PROCESS_DESCRIPTION_PHASE_PERCENTAGE);

    return Math.max(PROCESS_FILE_PHASE_PERCENTAGE, Math.min(MAX_ACTIVE_PROCESS_PERCENTAGE, percentage));
}

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

    if (run.status === "started" && counts.completed + counts.failed === total) {
        if (descriptionProgress && descriptionProgress.total > 0) {
            return {
                describing: formatStepProgress(descriptionProgress),
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

    const deletingRatio = progress.files.total > 0 ? clampRatio(progress.files.done / progress.files.total) : 0;
    const deleteDescriptionRatio =
        progress.descriptions.total > 0 ? descriptionRatio(progress.descriptions) : deletingRatio;
    const processPercentage =
        progress.descriptions.total > 0
            ? 5 + Math.round(deletingRatio * 55 + deleteDescriptionRatio * 35)
            : 5 + Math.round(deletingRatio * 90);

    return {
        process_step: processStep,
        process_percentage: Math.max(5, Math.min(95, progress.status === "pending" ? 5 : processPercentage)),
    };
}
