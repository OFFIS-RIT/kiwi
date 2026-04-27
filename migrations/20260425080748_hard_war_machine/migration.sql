CREATE TABLE "process_run_files" (
	"process_run_id" text,
	"file_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "process_run_files_pk" PRIMARY KEY("process_run_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "process_run_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "process_runs" (
	"id" text PRIMARY KEY,
	"graph_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "process_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "process_stats" ADD COLUMN "file_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX "process_run_files_file_idx" ON "process_run_files" ("file_id");--> statement-breakpoint
CREATE INDEX "process_runs_graph_status_created_idx" ON "process_runs" ("graph_id","status","created_at");--> statement-breakpoint
ALTER TABLE "process_run_files" ADD CONSTRAINT "process_run_files_process_run_id_process_runs_id_fkey" FOREIGN KEY ("process_run_id") REFERENCES "process_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "process_run_files" ADD CONSTRAINT "process_run_files_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "process_runs" ADD CONSTRAINT "process_runs_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;