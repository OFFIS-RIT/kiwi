ALTER TABLE "text_units"
  ADD COLUMN "chunks" json DEFAULT '[]'::json NOT NULL;

ALTER TABLE "sources"
  ADD COLUMN "source_chunk_ids" json DEFAULT '[]'::json NOT NULL;

UPDATE "text_units" AS "tu"
SET "chunks" = json_build_array(
  json_build_object(
    'id', 1,
    'type', 'text',
    'text', "tu"."text",
    'startPage', "tu"."start_page",
    'endPage', "tu"."end_page"
  )
)
FROM "files" AS "f"
WHERE "f"."id" = "tu"."file_id"
  AND "f"."file_type" <> 'pdf'
  AND "tu"."chunks"::jsonb = '[]'::jsonb;

UPDATE "sources" AS "s"
SET "source_chunk_ids" = '[1]'::json
FROM "text_units" AS "tu"
JOIN "files" AS "f" ON "f"."id" = "tu"."file_id"
WHERE "tu"."id" = "s"."text_unit_id"
  AND "f"."file_type" <> 'pdf'
  AND "s"."source_chunk_ids"::jsonb = '[]'::jsonb;
