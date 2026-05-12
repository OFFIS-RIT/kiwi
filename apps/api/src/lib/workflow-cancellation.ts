import { db } from "@kiwi/db";
import { error as logError } from "@kiwi/logger";
import { sql } from "drizzle-orm";
import { ow } from "../openworkflow";

type WorkflowRunIdRow = {
    id: string;
};

type CancellationContext = {
    graphIds: string[];
    fileIds?: string[];
    workflowNames?: string[];
};

export type WorkflowCancellationSummary = {
    requestedCount: number;
    canceledCount: number;
    skippedCount: number;
};

const OPENWORKFLOW_NAMESPACE_ID = "default";
const ACTIVE_WORKFLOW_STATUSES = ["pending", "running", "sleeping"] as const;
const MAX_CANCELLATION_PASSES = 5;

function textList(values: readonly string[]) {
    return sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
    );
}

function isAlreadyTerminalCancelError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return (
        error.message.includes("does not exist") ||
        (error.message.includes("Cannot cancel workflow run") && error.message.includes(" with status "))
    );
}

async function findActiveWorkflowRunIds(context: CancellationContext) {
    if (context.graphIds.length === 0) {
        return [];
    }

    const fileFilter =
        context.fileIds && context.fileIds.length > 0
            ? sql`AND "input"->>'fileId' IN (${textList(context.fileIds)})`
            : sql``;
    const workflowNameFilter =
        context.workflowNames && context.workflowNames.length > 0
            ? sql`AND "workflow_name" IN (${textList(context.workflowNames)})`
            : sql``;

    const result = await db.execute(sql<WorkflowRunIdRow>`
        SELECT "id"
        FROM openworkflow.workflow_runs
        WHERE "namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
          AND "status" IN (${textList(ACTIVE_WORKFLOW_STATUSES)})
          AND "input"->>'graphId' IN (${textList(context.graphIds)})
          ${fileFilter}
          ${workflowNameFilter}
        ORDER BY "created_at" DESC
    `);

    return [...new Set((result.rows as WorkflowRunIdRow[]).map((row) => row.id))];
}

async function cancelWorkflowRunIds(workflowRunIds: string[], context: CancellationContext) {
    let canceledCount = 0;
    let skippedCount = 0;
    const failedRunIds: string[] = [];

    for (const workflowRunId of workflowRunIds) {
        try {
            await ow.cancelWorkflowRun(workflowRunId);
            canceledCount += 1;
        } catch (error) {
            if (isAlreadyTerminalCancelError(error)) {
                skippedCount += 1;
                continue;
            }

            failedRunIds.push(workflowRunId);
            logError("failed to cancel workflow run", {
                workflowRunId,
                graphIds: context.graphIds,
                fileIds: context.fileIds,
                workflowNames: context.workflowNames,
                error,
            });
        }
    }

    if (failedRunIds.length > 0) {
        throw new Error(`Failed to cancel ${failedRunIds.length} workflow run(s)`);
    }

    return {
        requestedCount: workflowRunIds.length,
        canceledCount,
        skippedCount,
    } satisfies WorkflowCancellationSummary;
}

async function cancelActiveWorkflowRuns(context: CancellationContext) {
    const seenWorkflowRunIds = new Set<string>();
    let canceledCount = 0;
    let skippedCount = 0;

    for (let pass = 0; pass < MAX_CANCELLATION_PASSES; pass += 1) {
        const workflowRunIds = await findActiveWorkflowRunIds(context);
        if (workflowRunIds.length === 0) {
            return {
                requestedCount: seenWorkflowRunIds.size,
                canceledCount,
                skippedCount,
            } satisfies WorkflowCancellationSummary;
        }

        const newWorkflowRunIds = workflowRunIds.filter((workflowRunId) => !seenWorkflowRunIds.has(workflowRunId));

        if (newWorkflowRunIds.length === 0) {
            throw new Error(`Failed to cancel ${workflowRunIds.length} active workflow run(s)`);
        }

        for (const workflowRunId of newWorkflowRunIds) {
            seenWorkflowRunIds.add(workflowRunId);
        }

        const summary = await cancelWorkflowRunIds(newWorkflowRunIds, context);
        canceledCount += summary.canceledCount;
        skippedCount += summary.skippedCount;
    }

    const remainingWorkflowRunIds = await findActiveWorkflowRunIds(context);
    if (remainingWorkflowRunIds.length > 0) {
        throw new Error(`Failed to cancel ${remainingWorkflowRunIds.length} active workflow run(s)`);
    }

    return {
        requestedCount: seenWorkflowRunIds.size,
        canceledCount,
        skippedCount,
    } satisfies WorkflowCancellationSummary;
}

export async function cancelActiveGraphWorkflowRuns(graphIds: string[]) {
    return cancelActiveWorkflowRuns({ graphIds });
}

export async function cancelActiveFileProcessingWorkflowRuns(graphId: string, fileIds: string[]) {
    if (fileIds.length === 0) {
        return {
            requestedCount: 0,
            canceledCount: 0,
            skippedCount: 0,
        } satisfies WorkflowCancellationSummary;
    }

    return cancelActiveWorkflowRuns({
        graphIds: [graphId],
        fileIds,
        workflowNames: ["process-file"],
    });
}
