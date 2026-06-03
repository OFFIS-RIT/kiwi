ALTER TABLE "system_prompts" RENAME TO "graph_prompts";
--> statement-breakpoint
ALTER TABLE "graph_prompts" RENAME CONSTRAINT "system_prompts_pkey" TO "graph_prompts_pkey";
--> statement-breakpoint
ALTER TABLE "graph_prompts" RENAME CONSTRAINT "system_prompts_graph_id_graphs_id_fkey" TO "graph_prompts_graph_id_graphs_id_fkey";
--> statement-breakpoint
CREATE TABLE "user_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_prompts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "team_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_prompts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_prompts" ADD CONSTRAINT "user_prompts_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "team_prompts" ADD CONSTRAINT "team_prompts_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "graph_prompts_graph_created_idx" ON "graph_prompts" USING btree ("graph_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "user_prompts_user_created_idx" ON "user_prompts" USING btree ("user_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "team_prompts_team_created_idx" ON "team_prompts" USING btree ("team_id","created_at","id");
