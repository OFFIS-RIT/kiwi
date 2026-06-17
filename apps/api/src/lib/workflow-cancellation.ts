import * as Effect from "effect/Effect";
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

function findActiveWorkflowRunIds(context: CancellationContext): Effect.Effect<string[], unknown> {
    if (context.graphIds.length === 0) {
        return Effect.succeed([]);
    }

    const fileFilter =
        context.fileIds && context.fileIds.length > 0
            ? sql`AND "input"->>'fileId' IN (${textList(context.fileIds)})`
            : sql``;
    const workflowNameFilter =
        context.workflowNames && context.workflowNames.length > 0
            ? sql`AND "workflow_name" IN (${textList(context.workflowNames)})`
            : sql``;

    return Effect.map(
        Effect.tryPromise({
            try: () =>
                db.execute(sql<WorkflowRunIdRow>`
                    SELECT "id"
                    FROM openworkflow.workflow_runs
                    WHERE "namespace_id" = ${OPENWORKFLOW_NAMESPACE_ID}
                      AND "status" IN (${textList(ACTIVE_WORKFLOW_STATUSES)})
                      AND "input"->>'graphId' IN (${textList(context.graphIds)})
                      ${fileFilter}
                      ${workflowNameFilter}
                    ORDER BY "created_at" DESC
                `),
            catch: (error) => error,
        }),
        (result) => [...new Set((result.rows as WorkflowRunIdRow[]).map((row) => row.id))]
    );
}

function cancelWorkflowRunIds(
    workflowRunIds: string[],
    context: CancellationContext
): Effect.Effect<WorkflowCancellationSummary, unknown> {
    return Effect.gen(function* () {
        let canceledCount = 0;
        let skippedCount = 0;
        const failedRunIds: string[] = [];

        for (const workflowRunId of workflowRunIds) {
            const status = yield* Effect.match(
                Effect.tryPromise({
                    try: () => ow.cancelWorkflowRun(workflowRunId),
                    catch: (error) => error,
                }),
                {
                    onFailure: (error) => {
                        if (isAlreadyTerminalCancelError(error)) {
                            return "skipped" as const;
                        }

                        failedRunIds.push(workflowRunId);
                        logError("failed to cancel workflow run", {
                            workflowRunId,
                            graphIds: context.graphIds,
                            fileIds: context.fileIds,
                            workflowNames: context.workflowNames,
                            error,
                        });
                        return "failed" as const;
                    },
                    onSuccess: () => "canceled" as const,
                }
            );

            if (status === "canceled") {
                canceledCount += 1;
            } else if (status === "skipped") {
                skippedCount += 1;
            }
        }

        if (failedRunIds.length > 0) {
            return yield* Effect.fail(new Error(`Failed to cancel ${failedRunIds.length} workflow run(s)`));
        }

        return {
            requestedCount: workflowRunIds.length,
            canceledCount,
            skippedCount,
        } satisfies WorkflowCancellationSummary;
    });
}

function cancelActiveWorkflowRuns(context: CancellationContext): Effect.Effect<WorkflowCancellationSummary, unknown> {
    return Effect.gen(function* () {
        const seenWorkflowRunIds = new Set<string>();
        let canceledCount = 0;
        let skippedCount = 0;

        for (let pass = 0; pass < MAX_CANCELLATION_PASSES; pass += 1) {
            const workflowRunIds = yield* findActiveWorkflowRunIds(context);
            if (workflowRunIds.length === 0) {
                return {
                    requestedCount: seenWorkflowRunIds.size,
                    canceledCount,
                    skippedCount,
                } satisfies WorkflowCancellationSummary;
            }

            const newWorkflowRunIds = workflowRunIds.filter((workflowRunId) => !seenWorkflowRunIds.has(workflowRunId));

            if (newWorkflowRunIds.length === 0) {
                return yield* Effect.fail(new Error(`Failed to cancel ${workflowRunIds.length} active workflow run(s)`));
            }

            for (const workflowRunId of newWorkflowRunIds) {
                seenWorkflowRunIds.add(workflowRunId);
            }

            const summary = yield* cancelWorkflowRunIds(newWorkflowRunIds, context);
            canceledCount += summary.canceledCount;
            skippedCount += summary.skippedCount;
        }

        const remainingWorkflowRunIds = yield* findActiveWorkflowRunIds(context);
        if (remainingWorkflowRunIds.length > 0) {
            return yield* Effect.fail(new Error(`Failed to cancel ${remainingWorkflowRunIds.length} active workflow run(s)`));
        }

        return {
            requestedCount: seenWorkflowRunIds.size,
            canceledCount,
            skippedCount,
        } satisfies WorkflowCancellationSummary;
    });
}

export function cancelActiveGraphWorkflowRuns(graphIds: string[]): Effect.Effect<WorkflowCancellationSummary, unknown> {
    return cancelActiveWorkflowRuns({ graphIds });
}

export function cancelActiveFileProcessingWorkflowRuns(
    graphId: string,
    fileIds: string[]
): Effect.Effect<WorkflowCancellationSummary, unknown> {
    if (fileIds.length === 0) {
        return Effect.succeed({
            requestedCount: 0,
            canceledCount: 0,
            skippedCount: 0,
        } satisfies WorkflowCancellationSummary);
    }

    return cancelActiveWorkflowRuns({
        graphIds: [graphId],
        fileIds,
        workflowNames: ["process-file"],
    });
}
