ALTER TABLE "chats" ADD COLUMN "scope" text DEFAULT 'graph' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_scope_target_check" CHECK ((("scope" = 'graph' AND "project_id" IS NOT NULL AND "team_id" IS NULL) OR ("scope" = 'team' AND "project_id" IS NULL AND "team_id" IS NOT NULL)));--> statement-breakpoint
CREATE INDEX "idx_user_chats_user_team_updated_at" ON "chats" ("user_id","team_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_chats_user_team_archived_updated_at" ON "chats" ("user_id","team_id",("pinned_at" IS NULL),"updated_at" DESC,"id" DESC) WHERE "archived_at" IS NULL;
