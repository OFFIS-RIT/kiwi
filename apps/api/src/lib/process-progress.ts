import { FILE_PROCESS_STEP_VALUES, type FileProcessStep, type ProcessRunStatus } from "@kiwi/db/tables/graph";
import type { ApiBatchStepProgressLike } from "../types/routes";

type RunRow = {
    status: ProcessRunStatus;
};

type RunFile = {
    process_step: FileProcessStep;
};

export function buildProcessStepProgress(run: RunRow, files: RunFile[]): ApiBatchStepProgressLike | undefined {
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
        return {
            describing: `${total}/${total}`,
            completed: `${total}/${total}`,
        };
    }

    for (const step of FILE_PROCESS_STEP_VALUES) {
        if (counts[step] > 0) {
            progress[step] = `${counts[step]}/${total}`;
        }
    }

    return Object.keys(progress).length > 0 ? progress : undefined;
}
