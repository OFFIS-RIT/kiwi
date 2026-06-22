import { tryDb, tryDbVoid, type Database } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";
import {
    type FileProcessStep,
    filesTable,
    graphTable,
    type ProcessRunStatus,
    processRunFilesTable,
    processRunsTable,
    processStatsTable,
} from "@kiwi/db/tables/graph";
import { teamTable } from "@kiwi/db/tables/auth";
import { deleteFile, type FileStorage } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { env } from "../../env";
import { API_ERROR_CODES } from "../../types";
import { mapApiError } from "../../controllers/_shared/api-effect";
import type { GraphDetailFileRecord, GraphFileRecord, GraphListItem, GraphRecentChatItem } from "../../types/routes";
import { selectGraphFields, type GraphRecord } from "./access";
import { buildDeleteStepProgress, buildProcessStepProgress } from "../process-progress";
import { findActiveDeleteGraphFilesProgress, findProcessDescriptionProgress } from "../workflow-progress";
import type { GraphFileType } from "../graph-file-type";
import type { FileWithChecksum } from "./upload-file-type";

function tryUnknownPromise<T>(thunk: () => PromiseLike<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({ try: thunk, catch: (error) => error });
}

export { inferGraphFileType, type GraphFileType } from "../graph-file-type";
export {
    assertConfiguredUploadModels,
    inferSupportedUploadedFiles,
    unsupportedUploadResponse,
} from "./upload-file-type";
export type { FileWithChecksum, SupportedFileWithChecksum, UploadFileTypeCheck } from "./upload-file-type";

export type UploadedFile = {
    id: string;
    name: string;
    size: number;
    type: GraphFileType;
    mimeType: string;
    key: string;
    checksum?: string;
    metadata?: string;
    storageKind?: "internal" | "external";
    externalUrl?: string;
    externalProvider?: string;
    connectorBindingId?: string;
};
export type CreatedFileRecord = GraphFileRecord;
export type GraphFileUploadCommit = {
    graph: GraphRecord;
    addedFiles: CreatedFileRecord[];
    processRunId?: string;
    supersededFileIds: string[];
};
export type GraphFileRow = Omit<GraphDetailFileRecord, "created_at" | "updated_at"> & {
    created_at: Date | null;
    updated_at: Date | null;
};

type GraphListRow = {
    graph_id: string;
    graph_name: string;
    graph_state: "ready" | "updating";
    organization_id: string | null;
    team_id: string | null;
    team_name: string | null;
    user_id: string | null;
    hidden: boolean;
    has_failed_files: boolean;
};

type RunRow = {
    id: string;
    graph_id: string;
    status: ProcessRunStatus;
};

type SizeBucket = "tiny" | "small" | "medium" | "large" | "huge";

type RunFile = {
    process_run_id: string;
    process_step: FileProcessStep;
    size: number;
    type: string;
};

type Average = {
    duration: number;
    samples: number;
};

type RecentChatRow = {
    id: string;
    title: string;
    graphId: string;
    isPinned: boolean;
    updatedAt: Date | string | null;
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
    process_error_code: filesTable.processErrorCode,
    created_at: filesTable.createdAt,
    updated_at: filesTable.updatedAt,
};

export const selectGraphListFields = {
    graph_id: graphTable.id,
    graph_name: graphTable.name,
    graph_state: graphTable.state,
    organization_id: graphTable.organizationId,
    team_id: graphTable.teamId,
    team_name: teamTable.name,
    user_id: graphTable.userId,
    hidden: graphTable.hidden,
    has_failed_files: sql<boolean>`exists (
        select 1
        from ${filesTable}
        where ${filesTable.graphId} = ${graphTable.id}
          and ${filesTable.status} = 'failed'
          and ${filesTable.deleted} = false
    )`,
};

export const toGraphFileRecord = (file: GraphFileRow): GraphDetailFileRecord => ({
    ...file,
    created_at: file.created_at?.toISOString() ?? null,
    updated_at: file.updated_at?.toISOString() ?? null,
});

function buildProcessPercentage(files: RunFile[]): number {
    if (files.length === 0) {
        return 0;
    }

    const totalProgress = files.reduce((sum, file) => sum + FILE_STEP_PROGRESS[file.process_step], 0);

    return Math.max(0, Math.min(99, Math.round(totalProgress / files.length)));
}

function getFileSizeBucket(bytes: number): SizeBucket {
    if (bytes < 100_000) return "tiny";
    if (bytes < 1_000_000) return "small";
    if (bytes < 10_000_000) return "medium";
    if (bytes < 50_000_000) return "large";
    return "huge";
}

function pickAverage(
    file: RunFile,
    bucketAverages: Map<string, Average>,
    typeAverages: Map<string, Average>,
    globalAverage?: Average
): Average | undefined {
    const bucketAverage = bucketAverages.get(`${file.type}:${getFileSizeBucket(file.size)}`);
    if (bucketAverage && bucketAverage.samples >= MIN_BUCKET_SAMPLE_COUNT) {
        return bucketAverage;
    }

    const typeAverage = typeAverages.get(file.type);
    if (typeAverage && typeAverage.samples >= MIN_TYPE_SAMPLE_COUNT) {
        return typeAverage;
    }

    if (globalAverage && globalAverage.samples > 0) {
        return globalAverage;
    }

    return undefined;
}

function buildTimeEstimate(
    run: RunRow,
    files: RunFile[],
    bucketAverages: Map<string, Average>,
    typeAverages: Map<string, Average>,
    globalAverage?: Average
): Pick<GraphListItem, "process_estimated_duration" | "process_time_remaining"> {
    if (run.status !== "started" || files.length === 0) {
        return {};
    }

    let estimatedDuration = 0;
    let timeRemaining = 0;
    let filesWithEstimate = 0;

    for (const file of files) {
        const estimate = pickAverage(file, bucketAverages, typeAverages, globalAverage);
        if (!estimate) {
            continue;
        }

        const fileDuration = estimate.duration;
        const progress = FILE_STEP_PROGRESS[file.process_step];
        estimatedDuration += fileDuration;
        timeRemaining += fileDuration * (1 - progress / 100);
        filesWithEstimate += 1;
    }

    if (filesWithEstimate === 0) {
        return {};
    }

    return {
        process_estimated_duration: Math.ceil(estimatedDuration * ETA_BUFFER_MULTIPLIER),
        process_time_remaining: Math.ceil(timeRemaining * ETA_BUFFER_MULTIPLIER),
    };
}

function textArray(values: readonly string[]) {
    if (values.length === 0) {
        return sql`ARRAY[]::text[]`;
    }

    return sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
    )}]::text[]`;
}

function textList(values: readonly string[]) {
    return sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
    );
}

export const cleanupUploadedKeys = (uploadedKeys: string[]): Effect.Effect<number, unknown, FileStorage> =>
    Effect.map(
        Effect.all(
            uploadedKeys.map((key) =>
                Effect.match(
                    Effect.catchDefect(deleteFile(key, env.S3_BUCKET), (defect) => Effect.fail(defect)),
                    {
                        onFailure: () => false,
                        onSuccess: () => true,
                    }
                )
            ),
            { concurrency: "unbounded" }
        ),
        (deleteResults) => deleteResults.filter((deleted) => !deleted).length
    );

export function uniqueFilesByChecksum(
    files: File[],
    existingChecksums = new Set<string>()
): Effect.Effect<FileWithChecksum[], unknown> {
    return Effect.gen(function* () {
        const seenChecksums = new Set(existingChecksums);
        const uniqueFiles: FileWithChecksum[] = [];

        for (const file of files) {
            const fileBuffer = yield* tryUnknownPromise(() => file.arrayBuffer());
            const hashBuffer = yield* tryUnknownPromise(() => crypto.subtle.digest("SHA-256", fileBuffer));
            const checksum = [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

            if (seenChecksums.has(checksum)) {
                continue;
            }

            seenChecksums.add(checksum);
            uniqueFiles.push({ file, checksum });
        }

        return uniqueFiles;
    });
}

export const restoreGraphFileChangeFailure = (
    graphId: string,
    previousGraph: GraphRecord,
    addedFileIds: string[],
    uploadedKeys: string[],
    processRunId?: string,
    supersededFileIds: string[] = []
): Effect.Effect<void, unknown, Database | FileStorage> =>
    Effect.gen(function* () {
        const failedDeletes = yield* cleanupUploadedKeys(uploadedKeys);

        const cleanupResult = yield* Effect.match(
            tryDbVoid((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
                        if (processRunId) {
                            yield* tx.delete(processRunsTable).where(eq(processRunsTable.id, processRunId));
                        }

                        if (addedFileIds.length > 0) {
                            yield* tx.delete(filesTable).where(inArray(filesTable.id, addedFileIds));
                        }
                        if (supersededFileIds.length > 0) {
                            yield* tx
                                .update(filesTable)
                                .set({ deleted: false })
                                .where(inArray(filesTable.id, supersededFileIds));
                        }

                        yield* tx
                            .update(graphTable)
                            .set({
                                name: previousGraph.name,
                                description: previousGraph.description,
                                state: previousGraph.state,
                            })
                            .where(eq(graphTable.id, graphId));
                    })
                )
            ),
            {
                onFailure: (cleanupError) => ({ ok: false as const, cleanupError }),
                onSuccess: () => ({ ok: true as const }),
            }
        );

        if (!cleanupResult.ok) {
            logError("failed to rollback graph file change after enqueue failure", {
                graphId,
                addedFileCount: addedFileIds.length,
                uploadedKeyCount: uploadedKeys.length,
                failedS3CleanupCount: failedDeletes,
                error: cleanupResult.cleanupError,
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
    });

export function commitGraphFileUploads(options: {
    graph: GraphRecord;
    uploadedFiles: UploadedFile[];
    supersedeRepositoryUrls?: string[];
}): Effect.Effect<GraphFileUploadCommit, unknown, Database | FileStorage> {
    return Effect.gen(function* () {
        const result = yield* tryDb((db) =>
            db.transaction((tx) =>
                Effect.gen(function* (): Generator<Effect.Effect<unknown, unknown>, GraphFileUploadCommit> {
                    const uploadedFileIds = options.uploadedFiles.map((file) => file.id);
                    const supersededFiles =
                        options.supersedeRepositoryUrls && options.supersedeRepositoryUrls.length > 0
                            ? yield* tx
                                  .update(filesTable)
                                  .set({ deleted: true })
                                  .where(
                                      and(
                                          eq(filesTable.graphId, options.graph.id),
                                          eq(filesTable.type, "code"),
                                          eq(filesTable.deleted, false),
                                          sql`${filesTable.id} <> ALL(${textArray(uploadedFileIds)})`,
                                          sql`(${filesTable.metadata}::jsonb ->> 'repositoryUrl') = ANY(${textArray(
                                              options.supersedeRepositoryUrls
                                          )})`
                                      )
                                  )
                                  .returning({ id: filesTable.id })
                            : [];

                    const insertedFiles = yield* tx
                        .insert(filesTable)
                        .values(
                            options.uploadedFiles.map((file) => ({
                                id: file.id,
                                graphId: options.graph.id,
                                name: file.name,
                                size: file.size,
                                type: file.type,
                                mimeType: file.mimeType,
                                key: file.key,
                                storageKind: file.storageKind,
                                externalUrl: file.externalUrl,
                                externalProvider: file.externalProvider,
                                connectorBindingId: file.connectorBindingId,
                                checksum: file.checksum,
                                metadata: file.metadata,
                            }))
                        )
                        .onConflictDoNothing()
                        .returning(selectFileFields);

                    if (insertedFiles.length === 0) {
                        if (supersededFiles.length > 0) {
                            return yield* Effect.fail(
                                new Error("Repository snapshot did not insert replacement files")
                            );
                        }

                        return {
                            graph: options.graph,
                            addedFiles: insertedFiles,
                            processRunId: undefined,
                            supersededFileIds: [],
                        };
                    }

                    const [updatedGraph] = yield* tx
                        .update(graphTable)
                        .set({ state: "updating" })
                        .where(eq(graphTable.id, options.graph.id))
                        .returning(selectGraphFields);

                    const [processRun] = yield* tx
                        .insert(processRunsTable)
                        .values({
                            graphId: options.graph.id,
                            status: "pending",
                        })
                        .returning({ id: processRunsTable.id });
                    if (!processRun) {
                        return yield* Effect.fail(new Error("Failed to create process run"));
                    }

                    yield* tx.insert(processRunFilesTable).values(
                        insertedFiles.map((file) => ({
                            processRunId: processRun.id,
                            fileId: file.id,
                        }))
                    );

                    return {
                        graph: updatedGraph ?? options.graph,
                        addedFiles: insertedFiles,
                        processRunId: processRun.id,
                        supersededFileIds: supersededFiles.map((file) => file.id),
                    };
                })
            )
        );

        const addedKeys = new Set(result.addedFiles.map((file) => file.key));
        const skippedKeys = options.uploadedFiles.map((file) => file.key).filter((key) => !addedKeys.has(key));
        if (skippedKeys.length > 0) {
            yield* cleanupUploadedKeys(skippedKeys);
        }

        return result;
    });
}

export function mapGraphError(statusFn: StatusFn, error: unknown) {
    return mapApiError(statusFn, error);
}

function listRecentChatsByGraphId(
    graphIds: string[],
    userId: string
): Effect.Effect<Map<string, GraphRecentChatItem[]>, unknown, Database> {
    return Effect.map(
        tryDb((db) =>
            db.execute(sql<RecentChatRow>`
                WITH ranked AS (
                    SELECT
                        id,
                        title,
                        project_id AS "graphId",
                        FALSE AS "isPinned",
                        updated_at,
                        created_at,
                        ROW_NUMBER() OVER (
                            PARTITION BY project_id
                            ORDER BY
                                updated_at DESC,
                                created_at DESC
                        ) AS row_number
                    FROM chats
                    WHERE user_id = ${userId}
                      AND project_id IN (${textList(graphIds)})
                      AND archived_at IS NULL
                      AND pinned_at IS NULL
                )
                SELECT id, title, "graphId", "isPinned", updated_at AS "updatedAt"
                FROM ranked
                WHERE row_number <= 6
                ORDER BY
                    "graphId" ASC,
                    updated_at DESC,
                    created_at DESC
            `)
        ),
        (result) => {
            const recentChatsByGraphId = new Map<string, GraphRecentChatItem[]>();
            for (const row of result as RecentChatRow[]) {
                const recentChats = recentChatsByGraphId.get(row.graphId) ?? [];
                const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt;
                recentChats.push({
                    id: row.id,
                    title: row.title,
                    isPinned: row.isPinned,
                    updatedAt: updatedAt ?? null,
                });
                recentChatsByGraphId.set(row.graphId, recentChats);
            }

            return recentChatsByGraphId;
        }
    );
}

export const mapGraphListItem = (
    graph: GraphListRow,
    recentChats: GraphRecentChatItem[] = [],
    processing?: Partial<GraphListItem>
): GraphListItem => {
    if (!graph.organization_id && !graph.user_id) {
        throw new Error(API_ERROR_CODES.INVALID_GRAPH_OWNER);
    }

    const scope = graph.user_id ? "private" : graph.team_id ? "team" : "organization";

    return {
        graph_id: graph.graph_id,
        graph_name: graph.graph_name,
        graph_state: graph.graph_state === "updating" ? "update" : "ready",
        organization_id: graph.organization_id,
        team_id: graph.team_id,
        team_name: graph.team_name,
        scope,
        hidden: graph.hidden,
        has_failed_files: graph.has_failed_files ?? false,
        recent_chats: recentChats,
        ...(graph.graph_state === "updating"
            ? {
                  process_percentage: 0,
                  ...processing,
              }
            : {}),
    };
};

export function mapGraphListItemsWithProcessing(
    graphs: GraphListRow[],
    userId: string
): Effect.Effect<GraphListItem[], unknown, Database> {
    return Effect.catchDefect(
        Effect.gen(function* () {
            if (graphs.length === 0) {
                return [];
            }

            const graphIds = graphs.map((graph) => graph.graph_id);
            const sizeBucket = sql<SizeBucket>`CASE
            WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 100000 THEN 'tiny'
            WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 1000000 THEN 'small'
            WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 10000000 THEN 'medium'
            WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 50000000 THEN 'large'
            ELSE 'huge'
        END`;
            const [recentChatsByGraphId, runs, bucketStats, typeStats, [globalStats], deleteProgressByGraphId] =
                yield* Effect.all(
                    [
                        listRecentChatsByGraphId(graphIds, userId),
                        tryDb((db) =>
                            db
                                .select({
                                    id: processRunsTable.id,
                                    graph_id: processRunsTable.graphId,
                                    status: processRunsTable.status,
                                })
                                .from(processRunsTable)
                                .where(
                                    and(
                                        inArray(processRunsTable.graphId, graphIds),
                                        inArray(processRunsTable.status, ["pending", "started"])
                                    )
                                )
                                .orderBy(asc(processRunsTable.graphId), asc(processRunsTable.createdAt))
                        ),
                        tryDb((db) =>
                            db
                                .select({
                                    file_type: processStatsTable.fileType,
                                    size_bucket: sizeBucket,
                                    average_duration: sql<number>`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                                    sample_count: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
                                })
                                .from(processStatsTable)
                                .groupBy(processStatsTable.fileType, sizeBucket)
                        ),
                        tryDb((db) =>
                            db
                                .select({
                                    file_type: processStatsTable.fileType,
                                    average_duration: sql<number>`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                                    sample_count: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
                                })
                                .from(processStatsTable)
                                .groupBy(processStatsTable.fileType)
                        ),
                        tryDb((db) =>
                            db
                                .select({
                                    average_duration: sql<
                                        number | null
                                    >`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                                    sample_count: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
                                })
                                .from(processStatsTable)
                        ),
                        findActiveDeleteGraphFilesProgress(graphIds),
                    ],
                    { concurrency: "unbounded" }
                );

            const runByGraphId = new Map<string, RunRow>();
            for (const run of runs) {
                if (!runByGraphId.has(run.graph_id)) {
                    runByGraphId.set(run.graph_id, run);
                }
            }

            const runIds = Array.from(runByGraphId.values()).map((run) => run.id);
            const [runFiles, descriptionProgressByRunId] = yield* Effect.all(
                [
                    runIds.length > 0
                        ? tryDb((db) =>
                              db
                                  .select({
                                      process_run_id: processRunFilesTable.processRunId,
                                      process_step: filesTable.processStep,
                                      size: filesTable.size,
                                      type: filesTable.type,
                                  })
                                  .from(processRunFilesTable)
                                  .innerJoin(filesTable, eq(filesTable.id, processRunFilesTable.fileId))
                                  .where(inArray(processRunFilesTable.processRunId, runIds))
                          )
                        : Effect.succeed([]),
                    findProcessDescriptionProgress(runIds),
                ],
                { concurrency: "unbounded" }
            );

            const filesByRunId = new Map<string, RunFile[]>();
            for (const runFile of runFiles) {
                const files = filesByRunId.get(runFile.process_run_id) ?? [];
                files.push(runFile);
                filesByRunId.set(runFile.process_run_id, files);
            }

            const bucketAverages = new Map<string, Average>();
            for (const stat of bucketStats) {
                if (stat.average_duration) {
                    bucketAverages.set(`${stat.file_type}:${stat.size_bucket}`, {
                        duration: stat.average_duration,
                        samples: stat.sample_count,
                    });
                }
            }

            const typeAverages = new Map<string, Average>();
            for (const stat of typeStats) {
                if (stat.average_duration) {
                    typeAverages.set(stat.file_type, {
                        duration: stat.average_duration,
                        samples: stat.sample_count,
                    });
                }
            }

            const globalAverage =
                globalStats?.average_duration && globalStats.sample_count > 0
                    ? {
                          duration: globalStats.average_duration,
                          samples: globalStats.sample_count,
                      }
                    : undefined;

            return yield* Effect.try({
                try: () =>
                    graphs.map((graph) => {
                        const deleteProgress = deleteProgressByGraphId.get(graph.graph_id);
                        if (deleteProgress) {
                            return mapGraphListItem(
                                {
                                    ...graph,
                                    graph_state: "updating",
                                },
                                recentChatsByGraphId.get(graph.graph_id) ?? [],
                                buildDeleteStepProgress(deleteProgress)
                            );
                        }

                        const run = runByGraphId.get(graph.graph_id);
                        if (!run) {
                            return mapGraphListItem(graph, recentChatsByGraphId.get(graph.graph_id) ?? []);
                        }
                        const files = filesByRunId.get(run.id) ?? [];

                        return mapGraphListItem(
                            {
                                ...graph,
                                graph_state: "updating",
                            },
                            recentChatsByGraphId.get(graph.graph_id) ?? [],
                            {
                                process_step: buildProcessStepProgress(
                                    run,
                                    files,
                                    descriptionProgressByRunId.get(run.id)
                                ),
                                process_percentage: buildProcessPercentage(files),
                                ...buildTimeEstimate(run, files, bucketAverages, typeAverages, globalAverage),
                            }
                        );
                    }),
                catch: (error) => error,
            });
        }),
        (defect) => Effect.fail(defect)
    );
}
