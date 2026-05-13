CREATE INDEX "account_user_provider_idx" ON "account" ("userId","providerId");--> statement-breakpoint
CREATE INDEX "entities_graph_active_id_idx" ON "entities" ("graph_id","active","id");--> statement-breakpoint
CREATE INDEX "files_graph_active_created_name_idx" ON "files" ("graph_id","created_at","name") WHERE "deleted" = false;--> statement-breakpoint
CREATE INDEX "files_graph_active_id_idx" ON "files" ("graph_id","id") WHERE "deleted" = false;--> statement-breakpoint
CREATE INDEX "files_graph_active_key_idx" ON "files" ("graph_id","file_key") WHERE "deleted" = false;--> statement-breakpoint
CREATE INDEX "graphs_visible_root_group_name_idx" ON "graphs" ("group_id","name") WHERE "graph_id" IS NULL AND "hidden" = false;--> statement-breakpoint
CREATE INDEX "group_users_user_group_idx" ON "group_users" ("user_id","group_id");--> statement-breakpoint
CREATE INDEX "relationships_graph_active_id_idx" ON "relationships" ("graph_id","active","id");--> statement-breakpoint
CREATE INDEX "relationships_graph_active_source_id_idx" ON "relationships" ("graph_id","active","source_id","id");--> statement-breakpoint
CREATE INDEX "relationships_graph_active_target_id_idx" ON "relationships" ("graph_id","active","target_id","id");--> statement-breakpoint
CREATE INDEX "sources_active_id_idx" ON "sources" ("active","id");--> statement-breakpoint
CREATE INDEX "sources_entity_active_id_idx" ON "sources" ("entity_id","active","id");--> statement-breakpoint
CREATE INDEX "sources_relationship_active_id_idx" ON "sources" ("relationship_id","active","id");--> statement-breakpoint
CREATE INDEX "sources_text_unit_idx" ON "sources" ("text_unit_id");--> statement-breakpoint
CREATE INDEX "text_units_file_idx" ON "text_units" ("file_id");
