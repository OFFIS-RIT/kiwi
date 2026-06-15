ALTER TABLE "relationships" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'RELATED' NOT NULL;
ALTER TABLE "relationships" ADD COLUMN IF NOT EXISTS "directed" boolean DEFAULT false NOT NULL;

INSERT INTO "file_type_configs" ("id", "organization_id", "file_type", "loader", "chunker", "chunk_size", "document_mode")
SELECT
	'ftc_' || "organization"."id" || '_code',
	"organization"."id",
	'code',
	'text',
	'semantic',
	2000,
	NULL
FROM "organization"
ON CONFLICT ("organization_id", "file_type") DO NOTHING;
