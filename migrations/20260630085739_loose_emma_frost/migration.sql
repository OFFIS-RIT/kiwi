CREATE TABLE "code_graph_edges" (
	"id" text PRIMARY KEY,
	"layer_id" text NOT NULL,
	"edge_key" text NOT NULL,
	"source_key" text NOT NULL,
	"target_key" text NOT NULL,
	"edge_kind" text NOT NULL,
	"file_id" text,
	"path" text,
	"start_line" integer,
	"end_line" integer,
	"start_index" integer,
	"end_index" integer,
	"properties" json DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "code_graph_edges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "code_graph_layers" (
	"id" text PRIMARY KEY,
	"graph_id" text NOT NULL,
	"layer" text NOT NULL,
	"repository_scope" text NOT NULL,
	"snapshot_key" text NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"metadata" json DEFAULT '{}' NOT NULL,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "code_graph_layers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "code_graph_nodes" (
	"id" text PRIMARY KEY,
	"layer_id" text NOT NULL,
	"node_key" text NOT NULL,
	"node_kind" text NOT NULL,
	"name" text NOT NULL,
	"file_id" text,
	"path" text,
	"start_line" integer,
	"end_line" integer,
	"start_index" integer,
	"end_index" integer,
	"properties" json DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "code_graph_nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "code_graph_edges_layer_key_idx" ON "code_graph_edges" ("layer_id","edge_key");--> statement-breakpoint
CREATE INDEX "code_graph_edges_layer_source_kind_idx" ON "code_graph_edges" ("layer_id","source_key","edge_kind");--> statement-breakpoint
CREATE INDEX "code_graph_edges_layer_target_kind_idx" ON "code_graph_edges" ("layer_id","target_key","edge_kind");--> statement-breakpoint
CREATE INDEX "code_graph_edges_layer_file_idx" ON "code_graph_edges" ("layer_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "code_graph_layers_identity_idx" ON "code_graph_layers" ("graph_id","layer","repository_scope","snapshot_key");--> statement-breakpoint
CREATE INDEX "code_graph_layers_current_idx" ON "code_graph_layers" ("graph_id","layer","repository_scope","created_at") WHERE "status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "code_graph_nodes_layer_key_idx" ON "code_graph_nodes" ("layer_id","node_key");--> statement-breakpoint
CREATE INDEX "code_graph_nodes_layer_kind_name_idx" ON "code_graph_nodes" ("layer_id","node_kind","name");--> statement-breakpoint
CREATE INDEX "code_graph_nodes_layer_file_idx" ON "code_graph_nodes" ("layer_id","file_id");--> statement-breakpoint
CREATE INDEX "code_graph_nodes_layer_path_idx" ON "code_graph_nodes" ("layer_id","path");--> statement-breakpoint
ALTER TABLE "code_graph_edges" ADD CONSTRAINT "code_graph_edges_layer_id_code_graph_layers_id_fkey" FOREIGN KEY ("layer_id") REFERENCES "code_graph_layers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "code_graph_edges" ADD CONSTRAINT "code_graph_edges_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "code_graph_layers" ADD CONSTRAINT "code_graph_layers_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "code_graph_nodes" ADD CONSTRAINT "code_graph_nodes_layer_id_code_graph_layers_id_fkey" FOREIGN KEY ("layer_id") REFERENCES "code_graph_layers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "code_graph_nodes" ADD CONSTRAINT "code_graph_nodes_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL;