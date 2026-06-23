import type { WorkerGraphEta } from "@kiwi/contracts/routes";
import { tryDb, type Database } from "@kiwi/db/effect";
import { and, asc, eq, inArray, sql } from "@kiwi/db/drizzle";
import {
    type FileProcessStep,
    filesTable,
    processRunFilesTable,
    processRunsTable,
    processStatsTable,
} from "@kiwi/db/tables/graph";
import * as Effect from "effect/Effect";
import { env } from "../../env";
import { assertCanViewGraph } from "../../lib/graph/access";
import { findProcessDescriptionProgress } from "../../lib/workflow-progress";
import {
    WorkerEta,
    type WorkerEtaAverage,
    type WorkerEtaFileState,
    type WorkerEtaSizeBucket,
} from "../../lib/worker-eta";
import type { AuthUser } from "../../middleware/auth";

const ACTIVE_PROCESS_RUN_STATUSES = ["pending", "started"] as const;

function processStepToEtaState(step: FileProcessStep): WorkerEtaFileState {
    if (step === "pending") {
        return "waiting";
    }

    if (step === "completed") {
        return "completed";
    }

    if (step === "failed") {
        return "failed";
    }

    return "active";
}

export const getGraphWorkerEta = Effect.fn("getGraphWorkerEta")(function* (input: {
    user: AuthUser;
    graphId: string;
}): Effect.fn.Return<WorkerGraphEta, unknown, Database | WorkerEta> {
    yield* assertCanViewGraph(input.user, input.graphId);
    const workerEta = yield* WorkerEta;

    const [run] = yield* tryDb((db) =>
        db
            .select({
                id: processRunsTable.id,
                status: processRunsTable.status,
                startedAt: processRunsTable.startedAt,
            })
            .from(processRunsTable)
            .where(
                and(
                    eq(processRunsTable.graphId, input.graphId),
                    inArray(processRunsTable.status, ACTIVE_PROCESS_RUN_STATUSES)
                )
            )
            .orderBy(asc(processRunsTable.createdAt))
            .limit(1)
    );

    if (!run) {
        return {
            graph_id: input.graphId,
            process_run_id: null,
            status: "idle",
        };
    }

    const sizeBucket = sql<WorkerEtaSizeBucket>`CASE
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 100000 THEN 'tiny'
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 1000000 THEN 'small'
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 10000000 THEN 'medium'
        WHEN ${processStatsTable.fileSizes} / NULLIF(${processStatsTable.files}, 0) < 50000000 THEN 'large'
        ELSE 'huge'
    END`;

    const etaData = yield* Effect.all(
        [
            tryDb((db) =>
                db
                    .select({
                        processStep: filesTable.processStep,
                        size: filesTable.size,
                        type: filesTable.type,
                    })
                    .from(processRunFilesTable)
                    .innerJoin(filesTable, eq(filesTable.id, processRunFilesTable.fileId))
                    .where(eq(processRunFilesTable.processRunId, run.id))
            ),
            tryDb((db) =>
                db
                    .select({
                        fileType: processStatsTable.fileType,
                        sizeBucket,
                        averageDuration: sql<number>`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                        sampleCount: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
                    })
                    .from(processStatsTable)
                    .groupBy(processStatsTable.fileType, sizeBucket)
            ),
            tryDb((db) =>
                db
                    .select({
                        fileType: processStatsTable.fileType,
                        averageDuration: sql<number>`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                        sampleCount: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
                    })
                    .from(processStatsTable)
                    .groupBy(processStatsTable.fileType)
            ),
            tryDb((db) =>
                db
                    .select({
                        averageDuration: sql<
                            number | null
                        >`SUM(${processStatsTable.totalTime}) / NULLIF(SUM(${processStatsTable.files}), 0)`,
                        sampleCount: sql<number>`COALESCE(SUM(${processStatsTable.files}), 0)`,
                    })
                    .from(processStatsTable)
            ),
            findProcessDescriptionProgress([run.id]),
        ],
        { concurrency: "unbounded" }
    );
    const [files, bucketStats, typeStats, [globalStats], descriptionProgressByRunId] = etaData;

    const bucketAverages = new Map<string, WorkerEtaAverage>();
    for (const stat of bucketStats) {
        if (stat.averageDuration && stat.sampleCount > 0) {
            bucketAverages.set(`${stat.fileType}:${stat.sizeBucket}`, {
                duration: stat.averageDuration,
                samples: stat.sampleCount,
            });
        }
    }

    const typeAverages = new Map<string, WorkerEtaAverage>();
    for (const stat of typeStats) {
        if (stat.averageDuration && stat.sampleCount > 0) {
            typeAverages.set(stat.fileType, {
                duration: stat.averageDuration,
                samples: stat.sampleCount,
            });
        }
    }

    const globalAverage =
        globalStats?.averageDuration && globalStats.sampleCount > 0
            ? {
                  duration: globalStats.averageDuration,
                  samples: globalStats.sampleCount,
              }
            : undefined;
    const eta = yield* workerEta.estimateProcessRun({
        status: run.status,
        startedAt: run.startedAt,
        files: files.map((file) => ({
            type: file.type,
            size: file.size,
            state: processStepToEtaState(file.processStep),
        })),
        bucketAverages,
        typeAverages,
        globalAverage,
        descriptionProgress: descriptionProgressByRunId.get(run.id),
        workerConcurrency: env.WORKER_CONCURRENCY,
    });

    return {
        graph_id: input.graphId,
        process_run_id: run.id,
        status: run.status,
        ...(eta ?? {}),
    };
});
