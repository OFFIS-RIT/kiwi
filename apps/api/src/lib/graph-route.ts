import { db } from "@kiwi/db";
import {
    FILE_PROCESS_STEP_VALUES,
    type FileProcessStep,
    filesTable,
    graphTable,
    processStatsTable,
} from "@kiwi/db/tables/graph";
import { deleteFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { and, eq, inArray, sql } from "drizzle-orm";
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

type GraphProcessFileRow = {
    graph_id: string;
    process_step: FileProcessStep;
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

function buildEtaConfidence(sampleCount: number): "low" | "medium" | "high" {
    if (sampleCount >= 50) {
        return "high";
    }

    if (sampleCount >= 10) {
        return "medium";
    }

    return "low";
}

function buildProcessStepProgress(fileRows: GraphProcessFileRow[]): ApiBatchStepProgressLike | undefined {
    if (fileRows.length === 0) {
        return undefined;
    }

    const counts = new Map<FileProcessStep, number>();
    for (const row of fileRows) {
        counts.set(row.process_step, (counts.get(row.process_step) ?? 0) + 1);
    }

    const allFilesComplete = fileRows.every((row) => row.process_step === "completed");
    const progress: ApiBatchStepProgressLike = {};

    for (const step of FILE_PROCESS_STEP_VALUES) {
        const count = counts.get(step);
        if (count) {
            progress[step] = String(count);
        }
    }

    if (allFilesComplete) {
        delete progress.completed;
        progress.describing = String(fileRows.length);
    }

    return Object.keys(progress).length > 0 ? progress : undefined;
}

function buildProcessPercentage(fileRows: GraphProcessFileRow[]): number {
    if (fileRows.length === 0) {
        return 0;
    }

    const allFilesComplete = fileRows.every((row) => row.process_step === "completed");
    if (allFilesComplete) {
        return 95;
    }

    const totalProgress = fileRows.reduce((sum, row) => sum + FILE_STEP_PROGRESS[row.process_step], 0);
    return Math.max(0, Math.min(99, Math.round(totalProgress / fileRows.length)));
}

function buildTimeEstimate(fileRows: GraphProcessFileRow[], averageFileDuration: number | null, sampleCount: number): Pick<
    GraphListItem,
    "process_estimated_duration" | "process_time_remaining" | "process_eta_confidence" | "process_eta_sample_count"
> {
    if (!averageFileDuration || fileRows.length === 0 || sampleCount <= 0) {
        return {};
    }

    const allFilesComplete = fileRows.every((row) => row.process_step === "completed");
    const describingWeight = allFilesComplete ? 1 : 0;
    const remainingEquivalentFiles =
        fileRows.reduce((sum, row) => sum + (1 - FILE_STEP_PROGRESS[row.process_step] / 100), 0) + describingWeight;

    return {
        process_estimated_duration: Math.round(averageFileDuration * (fileRows.length + describingWeight)),
        process_time_remaining: Math.round(averageFileDuration * remainingEquivalentFiles),
        process_eta_confidence: buildEtaConfidence(sampleCount),
        process_eta_sample_count: sampleCount,
    };
}

export const cleanupUploadedKeys = async (uploadedKeys: string[]) => {
    const deleteResults = await Promise.allSettled(uploadedKeys.map((key) => deleteFile(key, env.S3_BUCKET)));
    return deleteResults.filter((result) => result.status === "rejected").length;
};

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
        logError(
            "failed to cleanup graph after graph creation error",
            {
                graphId,
                ownerMode,
                phase,
                uploadedKeyCount: uploadedKeys.length,
                failedS3CleanupCount: failedDeletes,
                error: cleanupError,
            }
        );
        return;
    }

    if (failedDeletes > 0) {
        logError(
            "graph creation cleanup left orphaned s3 files",
            {
                graphId,
                ownerMode,
                phase,
                uploadedKeyCount: uploadedKeys.length,
                failedS3CleanupCount: failedDeletes,
            }
        );
    }
};

export const restoreGraphFileChangeFailure = async (
    graphId: string,
    previousGraph: GraphRecord,
    addedFileIds: string[],
    uploadedKeys: string[]
) => {
    const failedDeletes = await cleanupUploadedKeys(uploadedKeys);

    try {
        await db.transaction(async (tx) => {
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
        logError(
            "failed to rollback graph file change after enqueue failure",
            {
                graphId,
                addedFileCount: addedFileIds.length,
                uploadedKeyCount: uploadedKeys.length,
                failedS3CleanupCount: failedDeletes,
                error: cleanupError,
            }
        );
        return;
    }

    if (failedDeletes > 0) {
        logError(
            "graph file change rollback left orphaned s3 files",
            {
                graphId,
                addedFileCount: addedFileIds.length,
                uploadedKeyCount: uploadedKeys.length,
                failedS3CleanupCount: failedDeletes,
            }
        );
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
    const updatingGraphs = graphs.filter((graph) => graph.graph_state === "updating");

    if (updatingGraphs.length === 0) {
        return graphs.map((graph) => mapGraphListItem(graph));
    }

    const updatingGraphIds = updatingGraphs.map((graph) => graph.graph_id);
    const [fileRows, [processStats]] = await Promise.all([
        db
            .select({
                graph_id: filesTable.graphId,
                process_step: filesTable.processStep,
            })
            .from(filesTable)
            .where(and(inArray(filesTable.graphId, updatingGraphIds), eq(filesTable.deleted, false))),
        db
            .select({
                average_file_duration: sql<number | null>`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                sample_count: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
            })
            .from(processStatsTable),
    ]);

    const fileRowsByGraphId = new Map<string, GraphProcessFileRow[]>();
    for (const fileRow of fileRows) {
        const existingRows = fileRowsByGraphId.get(fileRow.graph_id) ?? [];
        existingRows.push(fileRow);
        fileRowsByGraphId.set(fileRow.graph_id, existingRows);
    }

    return graphs.map((graph) => {
        const graphFileRows = fileRowsByGraphId.get(graph.graph_id) ?? [];
        const processing: Partial<GraphListItem> =
            graph.graph_state === "updating"
                ? {
                      process_step: buildProcessStepProgress(graphFileRows),
                      process_percentage: buildProcessPercentage(graphFileRows),
                      ...buildTimeEstimate(
                          graphFileRows,
                          processStats?.average_file_duration ?? null,
                          processStats?.sample_count ?? 0
                      ),
                  }
                : {};

        return mapGraphListItem(graph, processing);
    });
}
