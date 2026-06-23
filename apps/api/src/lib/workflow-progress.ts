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

export async function findActiveDeleteGraphFilesProgress(graphIds: string[]) {
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
}

export async function findProcessDescriptionProgress(runIds: string[]) {
    if (runIds.length === 0) {
        return new Map<string, StepProgress>();
    }

    const result = await db.execute(sql<DescriptionWorkflowProgressRow>`
        WITH process_children AS (
            SELECT parent."input"->>'processRunId' AS "processRunId",
                   child."namespace_id" AS "childNamespaceId",
                   child."id" AS "childWorkflowRunId",
                   child."workflow_name" AS "childWorkflowName",
                   child."status" AS "childStatus",
                   child."input" AS "childInput"
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
              AND child."workflow_name" IN ('update-descriptions', 'process-descriptions-groups')
        ),
        direct_updates AS (
            SELECT "processRunId",
                   "childWorkflowRunId" AS "workflowRunId",
                   "childStatus" AS "status",
                   (
                       jsonb_array_length(COALESCE("childInput"->'entityIds', '[]'::jsonb)) +
                       jsonb_array_length(COALESCE("childInput"->'relationshipIds', '[]'::jsonb))
                   )::int AS "itemCount"
            FROM process_children
            WHERE "childWorkflowName" = 'update-descriptions'
        ),
        description_groups AS (
            SELECT "processRunId",
                   "childNamespaceId",
                   "childWorkflowRunId",
                   "childStatus",
                   (
                       jsonb_array_length(COALESCE("childInput"->'entityIds', '[]'::jsonb)) +
                       jsonb_array_length(COALESCE("childInput"->'relationshipIds', '[]'::jsonb))
                   )::int AS "itemCount"
            FROM process_children
            WHERE "childWorkflowName" = 'process-descriptions-groups'
        ),
        group_update_rows AS (
            SELECT description_group."processRunId",
                   description_group."childWorkflowRunId" AS "groupWorkflowRunId",
                   description_child."id" AS "workflowRunId",
                   description_child."status" AS "status",
                   (
                       jsonb_array_length(COALESCE(description_child."input"->'entityIds', '[]'::jsonb)) +
                       jsonb_array_length(COALESCE(description_child."input"->'relationshipIds', '[]'::jsonb))
                   )::int AS "itemCount"
            FROM description_groups description_group
            INNER JOIN openworkflow.step_attempts description_step
                ON description_step."namespace_id" = description_group."childNamespaceId"
               AND description_step."workflow_run_id" = description_group."childWorkflowRunId"
               AND description_step."kind" = 'workflow'
            INNER JOIN openworkflow.workflow_runs description_child
                ON description_child."namespace_id" = description_step."child_workflow_run_namespace_id"
               AND description_child."id" = description_step."child_workflow_run_id"
               AND description_child."workflow_name" = 'update-descriptions'
        ),
        group_update_progress AS (
            SELECT "processRunId",
                   "groupWorkflowRunId",
                   COALESCE(
                       SUM("itemCount") FILTER (WHERE "status" IN ('completed', 'succeeded')),
                       0
                   )::int AS "completedCount",
                   COALESCE(SUM("itemCount"), 0)::int AS "totalCount"
            FROM group_update_rows
            GROUP BY "processRunId", "groupWorkflowRunId"
        ),
        group_progress AS (
            SELECT description_group."processRunId",
                   GREATEST(
                       CASE
                           WHEN description_group."childStatus" IN ('completed', 'succeeded')
                               THEN description_group."itemCount"
                           ELSE 0
                       END,
                       COALESCE(group_update_progress."completedCount", 0)
                   )::int AS "completedCount",
                   GREATEST(
                       description_group."itemCount",
                       COALESCE(group_update_progress."totalCount", 0)
                   )::int AS "totalCount"
            FROM description_groups description_group
            LEFT JOIN group_update_progress
                ON group_update_progress."processRunId" = description_group."processRunId"
               AND group_update_progress."groupWorkflowRunId" = description_group."childWorkflowRunId"
        ),
        progress_rows AS (
            SELECT "processRunId",
                   CASE WHEN "status" IN ('completed', 'succeeded') THEN "itemCount" ELSE 0 END AS "completedCount",
                   "itemCount" AS "totalCount"
            FROM direct_updates
            UNION ALL
            SELECT "processRunId", "completedCount", "totalCount"
            FROM group_progress
        )
        SELECT "processRunId",
               COALESCE(SUM("completedCount"), 0)::int AS "completedCount",
               COALESCE(SUM("totalCount"), 0)::int AS "totalCount"
        FROM progress_rows
        GROUP BY "processRunId"
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
