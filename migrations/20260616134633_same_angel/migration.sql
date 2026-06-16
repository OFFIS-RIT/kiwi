ALTER TABLE "repository_graph_bindings" RENAME TO "connector_resource_bindings";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME CONSTRAINT "repository_graph_bindings_pkey" TO "connector_resource_bindings_pkey";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME CONSTRAINT "repository_graph_bindings_graph_id_graphs_id_fk" TO "connector_resource_bindings_graph_id_graphs_id_fk";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME CONSTRAINT "repository_graph_bindings_connector_installation_id_fk" TO "connector_resource_bindings_connector_installation_id_fk";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME CONSTRAINT "repository_graph_bindings_provider_check" TO "connector_resource_bindings_provider_check";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME CONSTRAINT "repository_graph_bindings_sync_status_check" TO "connector_resource_bindings_sync_status_check";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME COLUMN "provider_repository_id" TO "provider_resource_id";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME COLUMN "repository_full_name" TO "resource_display_name";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME COLUMN "repository_html_url" TO "resource_web_url";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME COLUMN "branch" TO "version_name";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME COLUMN "last_seen_commit_sha" TO "last_seen_version_id";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" RENAME COLUMN "last_synced_commit_sha" TO "last_synced_version_id";--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" ADD COLUMN "resource_kind" text DEFAULT 'git-repository' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" ADD COLUMN "sync_cursor" text;--> statement-breakpoint
ALTER TABLE "connector_resource_bindings" ADD COLUMN "resource_metadata" text;--> statement-breakpoint
ALTER INDEX "repository_graph_bindings_graph_unique" RENAME TO "connector_resource_bindings_graph_unique";--> statement-breakpoint
ALTER INDEX "repository_graph_bindings_repository_branch_unique" RENAME TO "connector_resource_bindings_resource_version_unique";--> statement-breakpoint
ALTER INDEX "repository_graph_bindings_provider_repo_branch_idx" RENAME TO "connector_resource_bindings_provider_resource_version_idx";--> statement-breakpoint
ALTER INDEX "repository_graph_bindings_installation_status_idx" RENAME TO "connector_resource_bindings_installation_status_idx";--> statement-breakpoint
ALTER TABLE "files" RENAME COLUMN "repository_binding_id" TO "connector_binding_id";--> statement-breakpoint
ALTER TABLE "files" RENAME CONSTRAINT "files_repository_binding_id_repository_graph_bindings_id_fk" TO "files_connector_binding_id_connector_resource_bindings_id_fk";--> statement-breakpoint
ALTER INDEX "files_repository_binding_active_idx" RENAME TO "files_connector_binding_active_idx";--> statement-breakpoint
ALTER TABLE "connector_webhook_events" RENAME COLUMN "provider_repository_id" TO "provider_resource_id";--> statement-breakpoint
ALTER TABLE "connector_webhook_events" RENAME COLUMN "branch" TO "version_name";--> statement-breakpoint
ALTER TABLE "connector_webhook_events" RENAME COLUMN "commit_sha" TO "version_id";--> statement-breakpoint
ALTER INDEX "connector_webhook_events_binding_lookup_idx" RENAME TO "connector_webhook_events_resource_lookup_idx";