CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
--> statement-breakpoint
CREATE INDEX "entities_graph_active_idx" ON "entities" ("graph_id", "active");
--> statement-breakpoint
CREATE INDEX "entities_name_trgm_idx" ON "entities" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "entities_embedding_diskann_idx" ON "entities" USING diskann ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX "relationships_graph_active_idx" ON "relationships" ("graph_id", "active");
--> statement-breakpoint
CREATE INDEX "relationships_description_trgm_idx" ON "relationships" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "relationships_embedding_diskann_idx" ON "relationships" USING diskann ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX "sources_description_trgm_idx" ON "sources" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sources_embedding_diskann_idx" ON "sources" USING diskann ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX "files_name_trgm_idx" ON "files" USING gin ("name" gin_trgm_ops);
