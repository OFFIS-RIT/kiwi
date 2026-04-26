import { db } from "@kiwi/db";
import {
    FILE_PROCESS_STEP_VALUES,
    type FileProcessStep,
    filesTable,
    graphTable,
    type ProcessRunStatus,
    processRunFilesTable,
    processRunsTable,
    processStatsTable,
} from "@kiwi/db/tables/graph";
import { deleteFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { env } from "../env";
import { API_ERROR_CODES, errorResponse } from "../types";
import type { ApiBatchStepProgressLike, GraphDetailFileRecord, GraphFileRecord, GraphListItem } from "../types/routes";
import { type GraphRecord } from "./graph-access";

export type GraphFileType = "pdf" | "doc" | "sheet" | "ppt" | "image" | "json" | "text";
export type UploadedFile = {
    name: string;
    size: number;
    type: GraphFileType;
    mimeType: string;
    key: string;
    checksum?: string;
};
export type FileWithChecksum = {
    file: File;
    checksum: string;
};
export type CreatedFileRecord = GraphFileRecord;
export type GraphFileRow = Omit<GraphDetailFileRecord, "created_at" | "updated_at"> & {
    created_at: Date | null;
    updated_at: Date | null;
};

type GraphListRow = {
    graph_id: string;
    graph_name: string;
    graph_state: "ready" | "updating";
    group_id: string | null;
    hidden: boolean;
};

type ProcessRunRow = {
    id: string;
    graph_id: string;
    status: ProcessRunStatus;
};

type SizeBucket = "tiny" | "small" | "medium" | "large" | "huge";
type EstimateSource = "bucket" | "type" | "global";

type RunFileRow = {
    process_run_id: string;
    process_step: FileProcessStep;
    size: number;
    type: string;
};

type Average = {
    averageDuration: number;
    sampleCount: number;
};

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

const ETA_BUFFER_MULTIPLIER = 1.15;
const MIN_BUCKET_SAMPLE_COUNT = 3;
const MIN_TYPE_SAMPLE_COUNT = 5;

type StatusFn = (code: number, body: unknown) => unknown;

export const selectFileFields = {
    id: filesTable.id,
    name: filesTable.name,
    type: filesTable.type,
    mimeType: filesTable.mimeType,
    size: filesTable.size,
    key: filesTable.key,
};

export const selectGraphDetailFileFields = {
    id: filesTable.id,
    project_id: filesTable.graphId,
    name: filesTable.name,
    file_key: filesTable.key,
    status: filesTable.status,
    process_step: filesTable.processStep,
    created_at: filesTable.createdAt,
    updated_at: filesTable.updatedAt,
};

export const selectGraphListFields = {
    graph_id: graphTable.id,
    graph_name: graphTable.name,
    graph_state: graphTable.state,
    group_id: graphTable.groupId,
    hidden: graphTable.hidden,
};

export const toGraphFileRecord = (file: GraphFileRow): GraphDetailFileRecord => ({
    ...file,
    created_at: file.created_at?.toISOString() ?? null,
    updated_at: file.updated_at?.toISOString() ?? null,
});

function buildProcessStepProgress(runFiles: RunFileRow[]): ApiBatchStepProgressLike | undefined {
    if (runFiles.length === 0) {
        return undefined;
    }

    const total = runFiles.length;
    const counts = Object.fromEntries(FILE_PROCESS_STEP_VALUES.map((step) => [step, 0])) as Record<
        FileProcessStep,
        number
    >;
    const progress: ApiBatchStepProgressLike = {};

    for (const file of runFiles) {
        counts[file.process_step] += 1;
    }

    for (const step of FILE_PROCESS_STEP_VALUES) {
        if (counts[step] > 0) {
            progress[step] = `${counts[step]}/${total}`;
        }
    }

    return Object.keys(progress).length > 0 ? progress : undefined;
}

function buildProcessPercentage(runFiles: RunFileRow[]): number {
    if (runFiles.length === 0) {
        return 0;
    }

    const totalProgress = runFiles.reduce((sum, file) => sum + FILE_STEP_PROGRESS[file.process_step], 0);

    return Math.max(0, Math.min(99, Math.round(totalProgress / runFiles.length)));
}

function getFileSizeBucket(bytes: number): SizeBucket {
    if (bytes < 100_000) return "tiny";
    if (bytes < 1_000_000) return "small";
    if (bytes < 10_000_000) return "medium";
    if (bytes < 50_000_000) return "large";
    return "huge";
}

function getSizeBucketSql() {
    return sql<SizeBucket>`CASE
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 100000 THEN 'tiny'
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 1000000 THEN 'small'
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 10000000 THEN 'medium'
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 50000000 THEN 'large'
        ELSE 'huge'
    END`;
}

function buildEtaConfidence(sourceCounts: Record<EstimateSource, number>): "low" | "medium" | "high" {
    const total = sourceCounts.bucket + sourceCounts.type + sourceCounts.global;
    if (total === 0) {
        return "low";
    }

    if (sourceCounts.bucket / total >= 0.5) {
        return "high";
    }

    if ((sourceCounts.bucket + sourceCounts.type) / total >= 0.5) {
        return "medium";
    }

    return "low";
}

function pickAverage(
    file: RunFileRow,
    bucketAverages: Map<string, Average>,
    typeAverages: Map<string, Average>,
    globalAverage?: Average
): { average: Average; source: EstimateSource } | undefined {
    const bucketAverage = bucketAverages.get(`${file.type}:${getFileSizeBucket(file.size)}`);
    if (bucketAverage && bucketAverage.sampleCount >= MIN_BUCKET_SAMPLE_COUNT) {
        return { average: bucketAverage, source: "bucket" };
    }

    const typeAverage = typeAverages.get(file.type);
    if (typeAverage && typeAverage.sampleCount >= MIN_TYPE_SAMPLE_COUNT) {
        return { average: typeAverage, source: "type" };
    }

    if (globalAverage && globalAverage.sampleCount > 0) {
        return { average: globalAverage, source: "global" };
    }

    return undefined;
}

function buildTimeEstimate(
    run: ProcessRunRow,
    runFiles: RunFileRow[],
    bucketAverages: Map<string, Average>,
    typeAverages: Map<string, Average>,
    globalAverage?: Average
): Pick<
    GraphListItem,
    "process_estimated_duration" | "process_time_remaining" | "process_eta_confidence" | "process_eta_sample_count"
> {
    if (run.status !== "started" || runFiles.length === 0) {
        return {};
    }

    let estimatedDuration = 0;
    let timeRemaining = 0;
    let sampleCount = 0;
    const sourceCounts: Record<EstimateSource, number> = {
        bucket: 0,
        type: 0,
        global: 0,
    };

    for (const file of runFiles) {
        const estimate = pickAverage(file, bucketAverages, typeAverages, globalAverage);
        if (!estimate) {
            return {};
        }

        const fileDuration = estimate.average.averageDuration;
        const progress = FILE_STEP_PROGRESS[file.process_step];
        estimatedDuration += fileDuration;
        timeRemaining += fileDuration * (1 - progress / 100);
        sampleCount += estimate.average.sampleCount;
        sourceCounts[estimate.source] += 1;
    }

    return {
        process_estimated_duration: Math.ceil(estimatedDuration * ETA_BUFFER_MULTIPLIER),
        process_time_remaining: Math.ceil(timeRemaining * ETA_BUFFER_MULTIPLIER),
        process_eta_confidence: buildEtaConfidence(sourceCounts),
        process_eta_sample_count: sampleCount,
    };
}

export const cleanupUploadedKeys = async (uploadedKeys: string[]) => {
    const deleteResults = await Promise.allSettled(uploadedKeys.map((key) => deleteFile(key, env.S3_BUCKET)));
    return deleteResults.filter((result) => result.status === "rejected").length;
};

export async function uniqueFilesByChecksum(
    files: File[],
    existingChecksums = new Set<string>()
): Promise<FileWithChecksum[]> {
    const seenChecksums = new Set(existingChecksums);
    const uniqueFiles: FileWithChecksum[] = [];

    for (const file of files) {
        const hashBuffer = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        const checksum = [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

        if (seenChecksums.has(checksum)) {
            continue;
        }

        seenChecksums.add(checksum);
        uniqueFiles.push({ file, checksum });
    }

    return uniqueFiles;
}

export const cleanupFailedGraphCreation = async (
    graphId: string,
    uploadedKeys: string[],
    phase: "upload" | "db_insert_files" | "enqueue",
    ownerMode: "group" | "user" | "graph"
) => {
    const failedDeletes = await cleanupUploadedKeys(uploadedKeys);

    try {
        await db.delete(graphTable).where(eq(graphTable.id, graphId));
    } catch (cleanupError) {
        logError("failed to cleanup graph after graph creation error", {
            graphId,
            ownerMode,
            phase,
            uploadedKeyCount: uploadedKeys.length,
            failedS3CleanupCount: failedDeletes,
            error: cleanupError,
        });
        return;
    }

    if (failedDeletes > 0) {
        logError("graph creation cleanup left orphaned s3 files", {
            graphId,
            ownerMode,
            phase,
            uploadedKeyCount: uploadedKeys.length,
            failedS3CleanupCount: failedDeletes,
        });
    }
};

export const restoreGraphFileChangeFailure = async (
    graphId: string,
    previousGraph: GraphRecord,
    addedFileIds: string[],
    uploadedKeys: string[],
    processRunId?: string
) => {
    const failedDeletes = await cleanupUploadedKeys(uploadedKeys);

    try {
        await db.transaction(async (tx) => {
            if (processRunId) {
                await tx.delete(processRunsTable).where(eq(processRunsTable.id, processRunId));
            }

            if (addedFileIds.length > 0) {
                await tx.delete(filesTable).where(inArray(filesTable.id, addedFileIds));
            }

            await tx
                .update(graphTable)
                .set({
                    name: previousGraph.name,
                    description: previousGraph.description,
                    state: previousGraph.state,
                })
                .where(eq(graphTable.id, graphId));
        });
    } catch (cleanupError) {
        logError("failed to rollback graph file change after enqueue failure", {
            graphId,
            addedFileCount: addedFileIds.length,
            uploadedKeyCount: uploadedKeys.length,
            failedS3CleanupCount: failedDeletes,
            error: cleanupError,
        });
        return;
    }

    if (failedDeletes > 0) {
        logError("graph file change rollback left orphaned s3 files", {
            graphId,
            addedFileCount: addedFileIds.length,
            uploadedKeyCount: uploadedKeys.length,
            failedS3CleanupCount: failedDeletes,
        });
    }
};

export function mapGraphError(statusFn: StatusFn, error: unknown) {
    if (!(error instanceof Error)) {
        return statusFn(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    if (error.message === API_ERROR_CODES.GROUP_NOT_FOUND) {
        return statusFn(404, errorResponse("Group not found", API_ERROR_CODES.GROUP_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.GRAPH_NOT_FOUND) {
        return statusFn(404, errorResponse("Graph not found", API_ERROR_CODES.GRAPH_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.INVALID_GRAPH_OWNER) {
        return statusFn(400, errorResponse("Invalid graph owner chain", API_ERROR_CODES.INVALID_GRAPH_OWNER));
    }

    if (error.message === API_ERROR_CODES.FORBIDDEN) {
        return statusFn(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }

    return statusFn(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}

export const mapGraphListItem = (graph: GraphListRow, processing?: Partial<GraphListItem>): GraphListItem => {
    if (!graph.group_id) {
        throw new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER);
    }

    return {
        graph_id: graph.graph_id,
        graph_name: graph.graph_name,
        graph_state: graph.graph_state === "updating" ? "update" : "ready",
        group_id: graph.group_id,
        hidden: graph.hidden,
        ...(graph.graph_state === "updating"
            ? {
                  process_percentage: 0,
                  ...processing,
              }
            : {}),
    };
};

export async function mapGraphListItemsWithProcessing(graphs: GraphListRow[]): Promise<GraphListItem[]> {
    if (graphs.length === 0) {
        return graphs.map((graph) => mapGraphListItem(graph));
    }

    const graphIds = graphs.map((graph) => graph.graph_id);
    const sizeBucketSql = getSizeBucketSql();
    const [processRuns, bucketStats, typeStats, [globalStats]] = await Promise.all([
        db
            .select({
                id: processRunsTable.id,
                graph_id: processRunsTable.graphId,
                status: processRunsTable.status,
            })
            .from(processRunsTable)
            .where(and(inArray(processRunsTable.graphId, graphIds), sql`${processRunsTable.status} <> 'completed'`))
            .orderBy(asc(processRunsTable.graphId), asc(processRunsTable.createdAt)),
        db
            .select({
                file_type: processStatsTable.fileType,
                size_bucket: sizeBucketSql,
                average_duration: sql<number>`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                sample_count: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
            })
            .from(processStatsTable)
            .groupBy(processStatsTable.fileType, sizeBucketSql),
        db
            .select({
                file_type: processStatsTable.fileType,
                average_duration: sql<number>`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                sample_count: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
            })
            .from(processStatsTable)
            .groupBy(processStatsTable.fileType),
        db
            .select({
                average_duration: sql<
                    number | null
                >`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                sample_count: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
            })
            .from(processStatsTable),
    ]);

    const currentRunByGraphId = new Map<string, ProcessRunRow>();
    for (const processRun of processRuns) {
        if (!currentRunByGraphId.has(processRun.graph_id)) {
            currentRunByGraphId.set(processRun.graph_id, processRun);
        }
    }

    const currentRunIds = Array.from(currentRunByGraphId.values()).map((run) => run.id);
    const runFiles =
        currentRunIds.length > 0
            ? await db
                  .select({
                      process_run_id: processRunFilesTable.processRunId,
                      process_step: filesTable.processStep,
                      size: filesTable.size,
                      type: filesTable.type,
                  })
                  .from(processRunFilesTable)
                  .innerJoin(filesTable, eq(filesTable.id, processRunFilesTable.fileId))
                  .where(inArray(processRunFilesTable.processRunId, currentRunIds))
            : [];

    const runFilesByRunId = new Map<string, RunFileRow[]>();
    for (const runFile of runFiles) {
        const existingFiles = runFilesByRunId.get(runFile.process_run_id) ?? [];
        existingFiles.push(runFile);
        runFilesByRunId.set(runFile.process_run_id, existingFiles);
    }

    const bucketAverages = new Map<string, Average>();
    for (const stat of bucketStats) {
        if (stat.average_duration) {
            bucketAverages.set(`${stat.file_type}:${stat.size_bucket}`, {
                averageDuration: stat.average_duration,
                sampleCount: stat.sample_count,
            });
        }
    }

    const typeAverages = new Map<string, Average>();
    for (const stat of typeStats) {
        if (stat.average_duration) {
            typeAverages.set(stat.file_type, {
                averageDuration: stat.average_duration,
                sampleCount: stat.sample_count,
            });
        }
    }

    const globalAverage =
        globalStats?.average_duration && globalStats.sample_count > 0
            ? {
                  averageDuration: globalStats.average_duration,
                  sampleCount: globalStats.sample_count,
              }
            : undefined;

    return graphs.map((graph) => {
        const currentRun = currentRunByGraphId.get(graph.graph_id);
        if (!currentRun) {
            return mapGraphListItem(graph);
        }
        const currentRunFiles = runFilesByRunId.get(currentRun.id) ?? [];

        return mapGraphListItem(
            {
                ...graph,
                graph_state: "updating",
            },
            {
                process_step: buildProcessStepProgress(currentRunFiles),
                process_percentage: buildProcessPercentage(currentRunFiles),
                ...buildTimeEstimate(currentRun, currentRunFiles, bucketAverages, typeAverages, globalAverage),
            }
        );
    });
}
