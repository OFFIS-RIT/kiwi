import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { sql } from "drizzle-orm";
import type { DeleteProgress, StepProgress } from "./process-progress";

const OPENWORKFLOW_NAMESPACE_ID = "default";
const ACTIVE_WORKFLOW_RUN_STATUSES = ["pending", "running", "sleeping"] as const;

type DeleteWorkflowRun = {
    id: string;
    graphId: string;
    status: string;
    fileIds: unknown;
};

type DeleteFileProgressRow = {
    workflowRunId: string;
    completedFileCount: number;
};

type DeleteDescriptionProgressRow = {
    workflowRunId: string;
    completedDescriptionCount: number;
    totalDescriptionCount: number;
};

type DescriptionWorkflowProgressRow = {
    processRunId: string;
    completedCount: number;
    totalCount: number;
};

type DeleteGraphProgress = DeleteProgress & {
    fileIds: Set<string>;
};

function textArray(values: readonly string[]) {
    if (values.length === 0) {
        throw new Error("textArray called with an empty array");
    }

    return sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
    )}]::text[]`;
}

function getWorkflowFileIds(run: DeleteWorkflowRun) {
    if (!Array.isArray(run.fileIds)) {
        return [run.id];
    }

    const fileIds = run.fileIds.filter((fileId): fileId is string => typeof fileId === "string" && fileId.length > 0);

    return fileIds.length > 0 ? fileIds : [run.id];
}

export function findActiveDeleteGraphFilesProgress(
    graphIds: string[]
): Effect.Effect<Map<string, DeleteProgress>, unknown> {
    return Effect.tryPromise(async () => {
        if (graphIds.length === 0) {
            return new Map<string, DeleteProgress>();
        }

        const result = await db.execute(sql<DeleteWorkflowRun>`
            SELECT "id" AS "id",
                   "input"->>'graphId' AS "graphId",
                   "status" AS "status",
                   COALESCE("input"->'fileIds', '[]'::jsonb) AS "fileIds"
            FROM openworkflow.workflow_runs
            WHERE "namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
              AND "workflow_name" = 'delete-graph-files'
              AND "status" = ANY(${textArray(ACTIVE_WORKFLOW_RUN_STATUSES)})
              AND "input"->>'graphId' = ANY(${textArray(graphIds)})
            ORDER BY "created_at" DESC
        `);

        const runs = result.rows as DeleteWorkflowRun[];
        const runIds = runs.map((run) => run.id);
        if (runIds.length === 0) {
            return new Map<string, DeleteProgress>();
        }

        const [fileProgressRows, descriptionProgressRows] = await Promise.all([
            db.execute(sql<DeleteFileProgressRow>`
                SELECT parent."id" AS "workflowRunId",
                       COUNT(DISTINCT delete_child."id") FILTER (
                           WHERE delete_child."id" IS NOT NULL
                             AND (
                                 delete_child."status" IN ('completed', 'succeeded')
                                 OR cleanup_step."id" IS NOT NULL
                             )
                       )::int AS "completedFileCount"
                FROM openworkflow.workflow_runs parent
                LEFT JOIN openworkflow.step_attempts delete_step
                    ON delete_step."namespace_id" = parent."namespace_id"
                   AND delete_step."workflow_run_id" = parent."id"
                   AND delete_step."kind" = 'workflow'
                LEFT JOIN openworkflow.workflow_runs delete_child
                    ON delete_child."namespace_id" = delete_step."child_workflow_run_namespace_id"
                   AND delete_child."id" = delete_step."child_workflow_run_id"
                   AND delete_child."workflow_name" = 'delete-file'
                LEFT JOIN openworkflow.step_attempts cleanup_step
                    ON cleanup_step."namespace_id" = delete_child."namespace_id"
                   AND cleanup_step."workflow_run_id" = delete_child."id"
                   AND cleanup_step."step_name" = 'remove-file-graph-data'
                   AND cleanup_step."status" IN ('completed', 'succeeded')
                WHERE parent."namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
                  AND parent."id" = ANY(${textArray(runIds)})
                GROUP BY parent."id"
            `),
            db.execute(sql<DeleteDescriptionProgressRow>`
                SELECT parent."id" AS "workflowRunId",
                       COUNT(DISTINCT description_child."id") FILTER (
                           WHERE description_child."status" IN ('completed', 'succeeded')
                       )::int AS "completedDescriptionCount",
                       COUNT(DISTINCT description_child."id")::int AS "totalDescriptionCount"
                FROM openworkflow.workflow_runs parent
                INNER JOIN openworkflow.step_attempts delete_step
                    ON delete_step."namespace_id" = parent."namespace_id"
                   AND delete_step."workflow_run_id" = parent."id"
                   AND delete_step."kind" = 'workflow'
                INNER JOIN openworkflow.workflow_runs delete_child
                    ON delete_child."namespace_id" = delete_step."child_workflow_run_namespace_id"
                   AND delete_child."id" = delete_step."child_workflow_run_id"
                   AND delete_child."workflow_name" = 'delete-file'
                INNER JOIN openworkflow.step_attempts description_step
                    ON description_step."namespace_id" = delete_child."namespace_id"
                   AND description_step."workflow_run_id" = delete_child."id"
                   AND description_step."kind" = 'workflow'
                INNER JOIN openworkflow.workflow_runs description_child
                    ON description_child."namespace_id" = description_step."child_workflow_run_namespace_id"
                   AND description_child."id" = description_step."child_workflow_run_id"
                   AND description_child."workflow_name" = 'update-descriptions'
                WHERE parent."namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
                  AND parent."id" = ANY(${textArray(runIds)})
                GROUP BY parent."id"
            `),
        ]);

        const fileProgressByRunId = new Map(
            (fileProgressRows.rows as DeleteFileProgressRow[]).map((row) => [row.workflowRunId, row])
        );
        const descriptionProgressByRunId = new Map(
            (descriptionProgressRows.rows as DeleteDescriptionProgressRow[]).map((row) => [row.workflowRunId, row])
        );
        const progressByGraphId = new Map<string, DeleteGraphProgress>();
        for (const run of runs) {
            const fileIds = getWorkflowFileIds(run);
            const fileProgress = fileProgressByRunId.get(run.id);
            const descriptionProgress = descriptionProgressByRunId.get(run.id);
            const existing =
                progressByGraphId.get(run.graphId) ??
                ({
                    status: run.status,
                    files: { done: 0, total: 0 },
                    descriptions: { done: 0, total: 0 },
                    fileIds: new Set<string>(),
                } satisfies DeleteGraphProgress);

            for (const fileId of fileIds) {
                existing.fileIds.add(fileId);
            }

            const total = Math.max(existing.fileIds.size, 1);

            progressByGraphId.set(run.graphId, {
                status: existing.status === "running" || run.status === "running" ? "running" : run.status,
                files: {
                    done: Math.min(existing.files.done + (fileProgress?.completedFileCount ?? 0), total),
                    total,
                },
                descriptions: {
                    done: existing.descriptions.done + (descriptionProgress?.completedDescriptionCount ?? 0),
                    total: existing.descriptions.total + (descriptionProgress?.totalDescriptionCount ?? 0),
                },
                fileIds: existing.fileIds,
            });
        }

        return new Map(
            [...progressByGraphId.entries()].map(([graphId, progress]) => [
                graphId,
                {
                    status: progress.status,
                    files: progress.files,
                    descriptions: progress.descriptions,
                },
            ])
        );
    });
}

export function findProcessDescriptionProgress(runIds: string[]): Effect.Effect<Map<string, StepProgress>, unknown> {
    return Effect.tryPromise(async () => {
        if (runIds.length === 0) {
            return new Map<string, StepProgress>();
        }

        const result = await db.execute(sql<DescriptionWorkflowProgressRow>`
            SELECT parent."input"->>'processRunId' AS "processRunId",
                   COUNT(DISTINCT child."id") FILTER (WHERE child."status" IN ('completed', 'succeeded'))::int AS "completedCount",
                   COUNT(DISTINCT child."id")::int AS "totalCount"
            FROM openworkflow.workflow_runs parent
            INNER JOIN openworkflow.step_attempts step_attempt
                ON step_attempt."namespace_id" = parent."namespace_id"
               AND step_attempt."workflow_run_id" = parent."id"
            INNER JOIN openworkflow.workflow_runs child
                ON child."namespace_id" = step_attempt."child_workflow_run_namespace_id"
               AND child."id" = step_attempt."child_workflow_run_id"
            WHERE parent."namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
              AND parent."workflow_name" = 'process-files'
              AND parent."status" = ANY(${textArray(ACTIVE_WORKFLOW_RUN_STATUSES)})
              AND parent."input"->>'processRunId' = ANY(${textArray(runIds)})
              AND step_attempt."kind" = 'workflow'
              AND child."workflow_name" = 'update-descriptions'
            GROUP BY parent."input"->>'processRunId'
        `);

        return new Map(
            (result.rows as DescriptionWorkflowProgressRow[]).map((row) => [
                row.processRunId,
                {
                    done: row.completedCount,
                    total: row.totalCount,
                },
            ])
        );
    });
}
