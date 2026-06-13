-- Custom SQL migration file, put your code below! --

INSERT INTO "file_type_configs" ("id", "organization_id", "file_type", "loader", "chunker", "chunk_size", "document_mode")
SELECT
	'ftc_' || "organization"."id" || '_' || defaults."file_type",
	"organization"."id",
	defaults."file_type",
	defaults."loader",
	defaults."chunker",
	defaults."chunk_size",
	defaults."document_mode"
FROM "organization"
CROSS JOIN (
	VALUES
		('jsonl', 'json', 'json', 500, NULL),
		('jsonc', 'json', 'json', 500, NULL)
) AS defaults("file_type", "loader", "chunker", "chunk_size", "document_mode")
ON CONFLICT ("organization_id", "file_type") DO NOTHING;