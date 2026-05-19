import { db } from "@kiwi/db";
import { sql } from "drizzle-orm";
import type { DeleteProgress, StepProgress } from "./process-progress";

const OPENWORKFLOW_NAMESPACE_ID = "default";
const ACTIVE_WORKFLOW_RUN_STATUSES = ["pending", "running", "sleeping"] as const;

type DeleteWorkflowRun = {
    id: string;
    graphId: string;
    status: string;
    fileCount: number;
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

function textList(values: readonly string[]) {
    return sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
    );
}

export async function findActiveDeleteGraphFilesProgress(graphIds: string[]) {
    if (graphIds.length === 0) {
        return new Map<string, DeleteProgress>();
    }

    const result = await db.execute(sql<DeleteWorkflowRun>`
        SELECT "id" AS "id",
               "input"->>'graphId' AS "graphId",
               "status" AS "status",
               COALESCE(jsonb_array_length("input"->'fileIds'), 0)::int AS "fileCount"
        FROM openworkflow.workflow_runs
        WHERE "namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
          AND "workflow_name" = 'delete-graph-files'
          AND "status" IN (${textList(ACTIVE_WORKFLOW_RUN_STATUSES)})
          AND "input"->>'graphId' IN (${textList(graphIds)})
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
              AND parent."id" IN (${textList(runIds)})
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
              AND parent."id" IN (${textList(runIds)})
            GROUP BY parent."id"
        `),
    ]);

    const fileProgressByRunId = new Map(
        (fileProgressRows.rows as DeleteFileProgressRow[]).map((row) => [row.workflowRunId, row])
    );
    const descriptionProgressByRunId = new Map(
        (descriptionProgressRows.rows as DeleteDescriptionProgressRow[]).map((row) => [row.workflowRunId, row])
    );
    const progressByGraphId = new Map<string, DeleteProgress>();
    for (const run of runs) {
        const totalFileCount = Math.max(run.fileCount, 1);
        const fileProgress = fileProgressByRunId.get(run.id);
        const descriptionProgress = descriptionProgressByRunId.get(run.id);
        const existing = progressByGraphId.get(run.graphId);

        progressByGraphId.set(run.graphId, {
            status: existing?.status === "running" || run.status === "running" ? "running" : run.status,
            files: {
                done: (existing?.files.done ?? 0) + Math.min(fileProgress?.completedFileCount ?? 0, totalFileCount),
                total: (existing?.files.total ?? 0) + totalFileCount,
            },
            descriptions: {
                done: (existing?.descriptions.done ?? 0) + (descriptionProgress?.completedDescriptionCount ?? 0),
                total: (existing?.descriptions.total ?? 0) + (descriptionProgress?.totalDescriptionCount ?? 0),
            },
        });
    }

    return progressByGraphId;
}

export async function findProcessDescriptionProgress(runIds: string[]) {
    if (runIds.length === 0) {
        return new Map<string, StepProgress>();
    }

    const result = await db.execute(sql<DescriptionWorkflowProgressRow>`
        SELECT parent."input"->>'processRunId' AS "processRunId",
               COUNT(*) FILTER (WHERE child."status" IN ('completed', 'succeeded'))::int AS "completedCount",
               COUNT(*)::int AS "totalCount"
        FROM openworkflow.workflow_runs parent
        INNER JOIN openworkflow.step_attempts step_attempt
            ON step_attempt."namespace_id" = parent."namespace_id"
           AND step_attempt."workflow_run_id" = parent."id"
        INNER JOIN openworkflow.workflow_runs child
            ON child."namespace_id" = step_attempt."child_workflow_run_namespace_id"
           AND child."id" = step_attempt."child_workflow_run_id"
        WHERE parent."namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
          AND parent."workflow_name" = 'process-files'
          AND parent."input"->>'processRunId' IN (${textList(runIds)})
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
}
