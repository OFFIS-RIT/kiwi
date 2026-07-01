import { sql } from "drizzle-orm";
import { foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const WORKFLOW_NAMESPACE_ID = "default";

export const WORKFLOW_RUN_STATUS_VALUES = [
    "pending",
    "running",
    "sleeping",
    "succeeded",
    "completed",
    "failed",
    "canceled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUS_VALUES)[number];

export const STEP_ATTEMPT_STATUS_VALUES = ["running", "succeeded", "completed", "failed"] as const;
export type StepAttemptStatus = (typeof STEP_ATTEMPT_STATUS_VALUES)[number];

export const STEP_KIND_VALUES = ["function", "sleep", "workflow", "signal-send", "signal-wait"] as const;
export type StepKind = (typeof STEP_KIND_VALUES)[number];

export const workflowRunsTable = pgTable(
    "workflow_runs",
    {
        namespaceId: text("namespace_id").notNull().default(WORKFLOW_NAMESPACE_ID),
        id: text("id").notNull(),
        workflowName: text("workflow_name").notNull(),
        version: text("version"),
        status: text("status", { enum: WORKFLOW_RUN_STATUS_VALUES }).notNull().default("pending"),
        idempotencyKey: text("idempotency_key"),
        config: jsonb("config").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
        context: jsonb("context").$type<unknown | null>(),
        input: jsonb("input").$type<unknown | null>(),
        output: jsonb("output").$type<unknown | null>(),
        error: jsonb("error").$type<unknown | null>(),
        attempts: integer("attempts").notNull().default(0),
        parentStepAttemptNamespaceId: text("parent_step_attempt_namespace_id"),
        parentStepAttemptId: text("parent_step_attempt_id"),
        workerId: text("worker_id"),
        availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }),
        deadlineAt: timestamp("deadline_at", { withTimezone: true, mode: "date" }),
        startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
        finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        primaryKey({ name: "workflow_runs_pkey", columns: [table.namespaceId, table.id] }),
        uniqueIndex("workflow_runs_idempotency_key_unique")
            .on(table.namespaceId, table.workflowName, table.idempotencyKey)
            .where(sql`${table.idempotencyKey} IS NOT NULL`),
        index("workflow_runs_status_available_at_created_at_idx").on(
            table.namespaceId,
            table.status,
            table.availableAt,
            table.createdAt
        ),
        index("workflow_runs_workflow_name_idempotency_key_created_at_idx").on(
            table.namespaceId,
            table.workflowName,
            table.idempotencyKey,
            table.createdAt
        ),
        index("workflow_runs_parent_step_idx")
            .on(table.parentStepAttemptNamespaceId, table.parentStepAttemptId)
            .where(sql`${table.parentStepAttemptNamespaceId} IS NOT NULL AND ${table.parentStepAttemptId} IS NOT NULL`),
        index("workflow_runs_created_at_desc_idx").on(table.namespaceId, table.createdAt.desc()),
        index("workflow_runs_status_created_at_desc_idx").on(table.namespaceId, table.status, table.createdAt.desc()),
        index("workflow_runs_workflow_name_status_created_at_desc_idx").on(
            table.namespaceId,
            table.workflowName,
            table.status,
            table.createdAt.desc()
        ),
    ]
);

export const workflowStepAttemptsTable = pgTable(
    "workflow_step_attempts",
    {
        namespaceId: text("namespace_id").notNull().default(WORKFLOW_NAMESPACE_ID),
        id: text("id").notNull(),
        workflowRunId: text("workflow_run_id").notNull(),
        stepName: text("step_name").notNull(),
        kind: text("kind", { enum: STEP_KIND_VALUES }).notNull(),
        status: text("status", { enum: STEP_ATTEMPT_STATUS_VALUES }).notNull().default("running"),
        config: jsonb("config").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
        context: jsonb("context").$type<unknown | null>(),
        output: jsonb("output").$type<unknown | null>(),
        error: jsonb("error").$type<unknown | null>(),
        childWorkflowRunNamespaceId: text("child_workflow_run_namespace_id"),
        childWorkflowRunId: text("child_workflow_run_id"),
        startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
        finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        primaryKey({ name: "workflow_step_attempts_pkey", columns: [table.namespaceId, table.id] }),
        foreignKey({
            name: "workflow_step_attempts_workflow_run_fk",
            columns: [table.namespaceId, table.workflowRunId],
            foreignColumns: [workflowRunsTable.namespaceId, workflowRunsTable.id],
        }).onDelete("cascade"),
        foreignKey({
            name: "workflow_step_attempts_child_workflow_run_fk",
            columns: [table.childWorkflowRunNamespaceId, table.childWorkflowRunId],
            foreignColumns: [workflowRunsTable.namespaceId, workflowRunsTable.id],
        }).onDelete("set null"),
        index("workflow_step_attempts_workflow_run_created_at_idx").on(table.namespaceId, table.workflowRunId, table.createdAt),
        index("workflow_step_attempts_workflow_run_step_name_created_at_idx").on(
            table.namespaceId,
            table.workflowRunId,
            table.stepName,
            table.createdAt
        ),
        index("workflow_step_attempts_child_workflow_run_idx")
            .on(table.childWorkflowRunNamespaceId, table.childWorkflowRunId)
            .where(sql`${table.childWorkflowRunNamespaceId} IS NOT NULL AND ${table.childWorkflowRunId} IS NOT NULL`),
        index("workflow_step_attempts_signal_wait_idx")
            .on(table.namespaceId, sql`(${table.context}->>'signal')`)
            .where(sql`${table.kind} = 'signal-wait' AND ${table.status} = 'running'`),
    ]
);

export const workflowSignalsTable = pgTable(
    "workflow_signals",
    {
        namespaceId: text("namespace_id").notNull().default(WORKFLOW_NAMESPACE_ID),
        id: text("id").notNull(),
        signal: text("signal").notNull(),
        data: jsonb("data").$type<unknown | null>(),
        senderIdempotencyKey: text("sender_idempotency_key"),
        workflowRunId: text("workflow_run_id").notNull(),
        stepAttemptId: text("step_attempt_id").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    (table) => [
        primaryKey({ name: "workflow_signals_pkey", columns: [table.namespaceId, table.id] }),
        uniqueIndex("workflow_signals_step_attempt_idx").on(table.namespaceId, table.stepAttemptId),
        index("workflow_signals_idempotency_idx")
            .on(table.namespaceId, table.signal, table.senderIdempotencyKey)
            .where(sql`${table.senderIdempotencyKey} IS NOT NULL`),
        foreignKey({
            name: "workflow_signals_step_attempt_fk",
            columns: [table.namespaceId, table.stepAttemptId],
            foreignColumns: [workflowStepAttemptsTable.namespaceId, workflowStepAttemptsTable.id],
        }).onDelete("cascade"),
        foreignKey({
            name: "workflow_signals_workflow_run_fk",
            columns: [table.namespaceId, table.workflowRunId],
            foreignColumns: [workflowRunsTable.namespaceId, workflowRunsTable.id],
        }).onDelete("cascade"),
    ]
);
