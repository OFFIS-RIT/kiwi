-- Custom SQL migration file, put your code below! --

-- Seed per-organization file type configs with the processing defaults previously
-- hardcoded in apps/worker/workflows/process-file.ts (chunkers), the loader factory
-- defaults, and the previous DOCUMENT_MODE default ("hybrid") for OCR-capable
-- document types. Loaders and chunkers are fixed for now; chunk_size and
-- document_mode are editable per organization. Organizations created later fall
-- back to the same defaults in code until a row is written.
--
-- NOTE: document_mode is intentionally forced to 'hybrid' for all organizations,
-- regardless of any DOCUMENT_MODE env value previously in effect. The env var is
-- removed in this release; deployments that ran with DOCUMENT_MODE=plain or
-- DOCUMENT_MODE=ocr must set the desired mode per file type after migrating, via
-- the admin file type settings (or the /file-types API). Until then, 'hybrid'
-- requires an image-capable model for pdf/doc/ppt processing.
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
		('pdf', 'pdf', 'semantic', 2000, 'hybrid'),
		('doc', 'docx', 'semantic', 2000, 'hybrid'),
		('sheet', 'sheet', 'semantic', 2000, NULL),
		('ppt', 'pptx', 'semantic', 2000, 'hybrid'),
		('image', 'image', 'single', NULL, NULL),
		('audio', 'audio', 'transcript', 500, NULL),
		('video', 'video', 'transcript', 500, NULL),
		('html', 'html', 'semantic', 2000, NULL),
		('email', 'email', 'email', 500, NULL),
		('calendar', 'calendar', 'calendar', 500, NULL),
		('vcard', 'vcard', 'vcard', 500, NULL),
		('json', 'json', 'json', 500, NULL),
		('csv', 'csv', 'csv', 500, NULL),
		('xml', 'xml', 'semantic', 2000, NULL),
		('yaml', 'text', 'yaml', 500, NULL),
		('toml', 'text', 'toml', 500, NULL),
		('text', 'text', 'semantic', 2000, NULL)
) AS defaults("file_type", "loader", "chunker", "chunk_size", "document_mode")
ON CONFLICT ("organization_id", "file_type") DO NOTHING;
