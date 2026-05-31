CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_user_chats_user_project_archived_updated_at" ON "chats" ("user_id","project_id",("pinned_at" IS NULL),"updated_at" DESC,"id" DESC) WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chats_title_trgm_idx" ON "chats" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "graphs_name_trgm_idx" ON "graphs" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "team_name_trgm_idx" ON "team" USING gin ("name" gin_trgm_ops);
