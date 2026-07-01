CREATE TABLE "workflow_runs" (
	"namespace_id" text DEFAULT 'default',
	"id" text,
	"workflow_name" text NOT NULL,
	"version" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"context" jsonb,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"parent_step_attempt_namespace_id" text,
	"parent_step_attempt_id" text,
	"worker_id" text,
	"available_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_pkey" PRIMARY KEY("namespace_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_signals" (
	"namespace_id" text DEFAULT 'default',
	"id" text,
	"signal" text NOT NULL,
	"data" jsonb,
	"sender_idempotency_key" text,
	"workflow_run_id" text NOT NULL,
	"step_attempt_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_signals_pkey" PRIMARY KEY("namespace_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_step_attempts" (
	"namespace_id" text DEFAULT 'default',
	"id" text,
	"workflow_run_id" text NOT NULL,
	"step_name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"context" jsonb,
	"output" jsonb,
	"error" jsonb,
	"child_workflow_run_namespace_id" text,
	"child_workflow_run_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_step_attempts_pkey" PRIMARY KEY("namespace_id","id")
);
--> statement-breakpoint
ALTER TABLE "code_graph_layers" ADD COLUMN "branch" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
DROP INDEX "code_graph_layers_identity_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "code_graph_layers_identity_idx" ON "code_graph_layers" ("graph_id","layer","repository_scope","branch","snapshot_key");--> statement-breakpoint
DROP INDEX "code_graph_layers_current_idx";--> statement-breakpoint
CREATE INDEX "code_graph_layers_current_idx" ON "code_graph_layers" ("graph_id","layer","repository_scope","branch","created_at") WHERE "status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency_key_unique" ON "workflow_runs" ("namespace_id","workflow_name","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_runs_status_available_at_created_at_idx" ON "workflow_runs" ("namespace_id","status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_name_idempotency_key_created_at_idx" ON "workflow_runs" ("namespace_id","workflow_name","idempotency_key","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_parent_step_idx" ON "workflow_runs" ("parent_step_attempt_namespace_id","parent_step_attempt_id") WHERE "parent_step_attempt_namespace_id" IS NOT NULL AND "parent_step_attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_runs_created_at_desc_idx" ON "workflow_runs" ("namespace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_runs_status_created_at_desc_idx" ON "workflow_runs" ("namespace_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_name_status_created_at_desc_idx" ON "workflow_runs" ("namespace_id","workflow_name","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_signals_step_attempt_idx" ON "workflow_signals" ("namespace_id","step_attempt_id");--> statement-breakpoint
CREATE INDEX "workflow_signals_idempotency_idx" ON "workflow_signals" ("namespace_id","signal","sender_idempotency_key") WHERE "sender_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_step_attempts_workflow_run_created_at_idx" ON "workflow_step_attempts" ("namespace_id","workflow_run_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_step_attempts_workflow_run_step_name_created_at_idx" ON "workflow_step_attempts" ("namespace_id","workflow_run_id","step_name","created_at");--> statement-breakpoint
CREATE INDEX "workflow_step_attempts_child_workflow_run_idx" ON "workflow_step_attempts" ("child_workflow_run_namespace_id","child_workflow_run_id") WHERE "child_workflow_run_namespace_id" IS NOT NULL AND "child_workflow_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_step_attempts_signal_wait_idx" ON "workflow_step_attempts" ("namespace_id",("context"->>'signal')) WHERE "kind" = 'signal-wait' AND "status" = 'running';--> statement-breakpoint
ALTER TABLE "workflow_signals" ADD CONSTRAINT "workflow_signals_step_attempt_fk" FOREIGN KEY ("namespace_id","step_attempt_id") REFERENCES "workflow_step_attempts"("namespace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_signals" ADD CONSTRAINT "workflow_signals_workflow_run_fk" FOREIGN KEY ("namespace_id","workflow_run_id") REFERENCES "workflow_runs"("namespace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_step_attempts" ADD CONSTRAINT "workflow_step_attempts_workflow_run_fk" FOREIGN KEY ("namespace_id","workflow_run_id") REFERENCES "workflow_runs"("namespace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_step_attempts" ADD CONSTRAINT "workflow_step_attempts_child_workflow_run_fk" FOREIGN KEY ("child_workflow_run_namespace_id","child_workflow_run_id") REFERENCES "workflow_runs"("namespace_id","id") ON DELETE SET NULL;