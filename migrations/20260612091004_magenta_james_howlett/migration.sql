CREATE TABLE "file_type_configs" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"file_type" text NOT NULL,
	"loader" text NOT NULL,
	"chunker" text NOT NULL,
	"chunk_size" integer,
	"document_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_type_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "loader" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "chunker" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "chunk_size" integer;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "document_mode" text;--> statement-breakpoint
CREATE UNIQUE INDEX "file_type_configs_organization_file_type_unique" ON "file_type_configs" ("organization_id","file_type");--> statement-breakpoint
ALTER TABLE "file_type_configs" ADD CONSTRAINT "file_type_configs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;