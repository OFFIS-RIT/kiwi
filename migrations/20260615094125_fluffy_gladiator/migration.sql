DROP INDEX "files_graph_active_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "files_graph_active_key_idx" ON "files" ("graph_id","file_key") WHERE "deleted" = false;