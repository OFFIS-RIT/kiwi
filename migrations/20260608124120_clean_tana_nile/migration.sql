CREATE TABLE "graph_suggestions" (
	"id" text PRIMARY KEY,
	"graph_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_id" text,
	"entity_id" text,
	"reference" text NOT NULL,
	"suggestion" text NOT NULL,
	"suggested_by_user_id" text NOT NULL,
	"chat_id" text,
	"message_id" text,
	"applied_by_user_id" text,
	"applied_source_id" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_suggestions_target_check" CHECK (
                (
                    "kind" = 'source_correction'
                    AND "source_id" IS NOT NULL
                    AND "entity_id" IS NULL
                )
                OR
                (
                    "kind" = 'entity_addition'
                    AND "source_id" IS NULL
                    AND "entity_id" IS NOT NULL
                )
            )
);
--> statement-breakpoint
ALTER TABLE "graph_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "graph_suggestions_graph_status_created_idx" ON "graph_suggestions" ("graph_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "graph_suggestions_source_idx" ON "graph_suggestions" ("source_id");--> statement-breakpoint
CREATE INDEX "graph_suggestions_entity_idx" ON "graph_suggestions" ("entity_id");--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_entity_id_entities_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_suggested_by_user_id_user_id_fkey" FOREIGN KEY ("suggested_by_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_chat_id_chats_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_applied_by_user_id_user_id_fkey" FOREIGN KEY ("applied_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "graph_suggestions" ADD CONSTRAINT "graph_suggestions_applied_source_id_sources_id_fkey" FOREIGN KEY ("applied_source_id") REFERENCES "sources"("id") ON DELETE SET NULL;
