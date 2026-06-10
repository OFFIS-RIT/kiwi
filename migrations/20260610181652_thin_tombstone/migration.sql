CREATE TABLE "organization_prompts" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "organization_prompts_organization_created_idx" ON "organization_prompts" ("organization_id","created_at","id");--> statement-breakpoint
ALTER TABLE "organization_prompts" ADD CONSTRAINT "organization_prompts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
