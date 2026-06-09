CREATE TABLE "models" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"type" text NOT NULL,
	"adapter" text NOT NULL,
	"provider_model" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "models_organization_model_id_unique" ON "models" ("organization_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "models_organization_type_default_unique" ON "models" ("organization_id","type") WHERE "is_default" = true;--> statement-breakpoint
CREATE INDEX "models_organization_type_idx" ON "models" ("organization_id","type");--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;