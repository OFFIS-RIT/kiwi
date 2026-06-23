import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProcessRunStatus } from "@kiwi/db/tables/graph";

export type WorkerEtaSizeBucket = "tiny" | "small" | "medium" | "large" | "huge";
export type WorkerEtaFileState = "waiting" | "active" | "completed" | "failed";

export type WorkerEtaAverage = {
    duration: number;
    samples: number;
};

export type WorkerEtaFile = {
    type: string;
    size: number;
    state: WorkerEtaFileState;
};

export type WorkerEtaProgress = {
    done: number;
    total: number;
};

export type WorkerEtaHistory = {
    bucketAverages: ReadonlyMap<string, WorkerEtaAverage>;
    typeAverages: ReadonlyMap<string, WorkerEtaAverage>;
    globalAverage?: WorkerEtaAverage;
};

export type WorkerEtaProcessRunInput = WorkerEtaHistory & {
    status: ProcessRunStatus;
    startedAt?: Date | string | null;
    files: readonly WorkerEtaFile[];
    descriptionProgress?: WorkerEtaProgress;
    workerConcurrency?: number;
    now?: Date;
};

export type WorkerEtaEstimate = {
    process_estimated_duration: number;
    process_time_remaining: number;
};

export type WorkerEtaService = {
    readonly estimateProcessRun: (input: WorkerEtaProcessRunInput) => Effect.Effect<WorkerEtaEstimate | undefined>;
};

const DESCRIPTION_TO_FILE_RATIO = 10 / 90;
const ETA_BUFFER_MULTIPLIER = 1.15;
const MIN_ACTIVE_REMAINING_RATIO = 0.05;
const MIN_BUCKET_SAMPLE_COUNT = 3;
const MIN_TYPE_SAMPLE_COUNT = 5;
const MIN_GLOBAL_SAMPLE_COUNT = 5;
const BUCKET_PRIOR_SAMPLES = 2;
const TYPE_PRIOR_SAMPLES = 4;
const GLOBAL_PRIOR_SAMPLES = 8;

const DEFAULT_TYPE_DURATION_MS: Record<string, number> = {
    pdf: 120_000,
    doc: 120_000,
    sheet: 90_000,
    ppt: 120_000,
    image: 45_000,
    audio: 300_000,
    video: 600_000,
    html: 45_000,
    email: 30_000,
    calendar: 15_000,
    vcard: 15_000,
    json: 30_000,
    jsonl: 45_000,
    jsonc: 30_000,
    csv: 45_000,
    xml: 45_000,
    yaml: 30_000,
    toml: 30_000,
    code: 30_000,
    text: 30_000,
};

const DEFAULT_BUCKET_MULTIPLIER: Record<WorkerEtaSizeBucket, number> = {
    tiny: 0.5,
    small: 1,
    medium: 2,
    large: 4,
    huge: 8,
};

export function getWorkerEtaSizeBucket(bytes: number): WorkerEtaSizeBucket {
    if (bytes < 100_000) return "tiny";
    if (bytes < 1_000_000) return "small";
    if (bytes < 10_000_000) return "medium";
    if (bytes < 50_000_000) return "large";
    return "huge";
}

function positiveFinite(value: number | null | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function averageWithPrior(average: WorkerEtaAverage, priorDuration: number, priorSamples: number) {
    const duration = positiveFinite(average.duration);
    const samples = positiveFinite(average.samples);
    if (!duration || !samples) {
        return priorDuration;
    }

    return (duration * samples + priorDuration * priorSamples) / (samples + priorSamples);
}

export function estimateDefaultFileDuration(file: Pick<WorkerEtaFile, "type" | "size">): number {
    const baseDuration = DEFAULT_TYPE_DURATION_MS[file.type] ?? DEFAULT_TYPE_DURATION_MS.text;
    return baseDuration * DEFAULT_BUCKET_MULTIPLIER[getWorkerEtaSizeBucket(file.size)];
}

export function estimateWorkerFileDuration(
    file: Pick<WorkerEtaFile, "type" | "size">,
    history: WorkerEtaHistory
): number {
    const defaultDuration = estimateDefaultFileDuration(file);
    const bucketAverage = history.bucketAverages.get(`${file.type}:${getWorkerEtaSizeBucket(file.size)}`);
    if (bucketAverage && bucketAverage.samples >= MIN_BUCKET_SAMPLE_COUNT) {
        return averageWithPrior(bucketAverage, defaultDuration, BUCKET_PRIOR_SAMPLES);
    }

    const typeAverage = history.typeAverages.get(file.type);
    if (typeAverage && typeAverage.samples >= MIN_TYPE_SAMPLE_COUNT) {
        return averageWithPrior(typeAverage, defaultDuration, TYPE_PRIOR_SAMPLES);
    }

    if (history.globalAverage && history.globalAverage.samples >= MIN_GLOBAL_SAMPLE_COUNT) {
        return averageWithPrior(history.globalAverage, defaultDuration, GLOBAL_PRIOR_SAMPLES);
    }

    return defaultDuration;
}

function progressRatio(progress: WorkerEtaProgress | undefined) {
    if (!progress || progress.total <= 0) {
        return 0;
    }

    return Math.max(0, Math.min(1, progress.done / progress.total));
}

function toDate(value: Date | string | null | undefined): Date | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value;
    }

    if (!value) {
        return undefined;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function estimateParallelDuration(durations: number[], workerConcurrency: number): number {
    if (durations.length === 0) {
        return 0;
    }

    const slots = Array.from({ length: Math.min(durations.length, workerConcurrency) }, () => 0);
    for (const duration of [...durations].sort((a, b) => b - a)) {
        let targetIndex = 0;
        for (let index = 1; index < slots.length; index++) {
            if (slots[index]! < slots[targetIndex]!) {
                targetIndex = index;
            }
        }
        slots[targetIndex] += duration;
    }

    return Math.max(...slots);
}

export function estimateProcessRunEta(input: WorkerEtaProcessRunInput): WorkerEtaEstimate | undefined {
    if ((input.status !== "pending" && input.status !== "started") || input.files.length === 0) {
        return undefined;
    }

    const workerConcurrency =
        Number.isFinite(input.workerConcurrency) && input.workerConcurrency && input.workerConcurrency > 0
            ? Math.floor(input.workerConcurrency)
            : 1;
    const fileDurations: number[] = [];
    const waitingDurations: number[] = [];
    const activeDurations: number[] = [];

    for (const file of input.files) {
        const duration = estimateWorkerFileDuration(file, input);
        fileDurations.push(duration);

        if (file.state === "waiting") {
            waitingDurations.push(duration);
        } else if (file.state === "active") {
            activeDurations.push(duration);
        }
    }

    const totalFileDuration = fileDurations.reduce((sum, duration) => sum + duration, 0);

    if (totalFileDuration <= 0) {
        return undefined;
    }

    const startedAt = toDate(input.startedAt);
    const now = input.now ?? new Date();
    const elapsed = startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : 0;
    const activeRemainingDurations = activeDurations.map((duration) =>
        Math.max(duration * MIN_ACTIVE_REMAINING_RATIO, duration - elapsed)
    );
    const fileDuration = estimateParallelDuration(fileDurations, workerConcurrency);
    const fileTimeRemaining = estimateParallelDuration(
        [...waitingDurations, ...activeRemainingDurations],
        workerConcurrency
    );
    const descriptionParallelism = Math.min(workerConcurrency, input.descriptionProgress?.total ?? input.files.length);
    const descriptionDuration = (totalFileDuration * DESCRIPTION_TO_FILE_RATIO) / Math.max(1, descriptionParallelism);
    const descriptionRemaining = descriptionDuration * (1 - progressRatio(input.descriptionProgress));
    const totalDuration = fileDuration + descriptionDuration;
    const timeRemaining = fileTimeRemaining + descriptionRemaining;

    return {
        process_estimated_duration: Math.ceil(totalDuration * ETA_BUFFER_MULTIPLIER),
        process_time_remaining: Math.ceil(timeRemaining * ETA_BUFFER_MULTIPLIER),
    };
}

export class WorkerEta extends Context.Service<WorkerEta, WorkerEtaService>()("@kiwi/api/WorkerEta") {}

export const WorkerEtaLive = Layer.succeed(WorkerEta, {
    estimateProcessRun: Effect.fn("WorkerEta.estimateProcessRun")((input: WorkerEtaProcessRunInput) =>
        Effect.succeed(estimateProcessRunEta(input))
    ),
} satisfies WorkerEtaService);
