-- name: GetTextUnitIdsForFiles :many
SELECT id FROM text_units WHERE project_file_id = ANY($1::text[]);

-- name: GetTextUnitByID :one
SELECT * FROM text_units
WHERE id = $1;

-- name: UpsertTextUnits :many
WITH input AS (
    SELECT
        u.id,
        (sqlc.arg(project_file_ids)::text[])[u.ord]::text AS project_file_id,
        (sqlc.arg(texts)::text[])[u.ord]::text AS text
    FROM unnest(sqlc.arg(ids)::text[]) WITH ORDINALITY AS u(id, ord)
)
INSERT INTO text_units (id, project_file_id, text)
SELECT id, project_file_id, text
FROM input
ON CONFLICT (id) DO UPDATE
SET project_file_id = EXCLUDED.project_file_id,
    text = EXCLUDED.text,
    updated_at = NOW()
RETURNING id;

-- name: GetProjectIDFromTextUnit :one
SELECT p.id FROM graphs p
JOIN project_files f ON f.project_id = p.id
JOIN text_units tu ON tu.project_file_id = f.id
WHERE tu.id = $1;

-- name: GetFilesFromTextUnitIDs :many
-- Intentionally resolves only direct text_units.id values.
-- Legacy entity_sources/relationship_sources fallback was removed on purpose.
WITH project_scope AS (
  SELECT sqlc.arg(project_id)::text AS project_id
),
input_ids AS (
  SELECT DISTINCT trim(u.pid) AS pid
  FROM unnest(sqlc.arg(source_ids)::text[]) AS u(pid)
  WHERE trim(u.pid) <> ''
),
project_files_scope AS (
  SELECT pf.id
  FROM project_files pf
  JOIN project_scope ps ON ps.project_id = pf.project_id
),
resolved_text_units AS (
  SELECT tu.id, tu.project_file_id
  FROM input_ids i
  JOIN text_units tu ON tu.id = i.pid
  JOIN project_files_scope pfs ON pfs.id = tu.project_file_id
)
SELECT DISTINCT f.name, f.file_key, rtu.id
FROM resolved_text_units rtu
JOIN project_files f ON f.id = rtu.project_file_id
JOIN project_scope ps ON ps.project_id = f.project_id;

-- name: DeleteTextUnitsByFileIDs :exec
DELETE FROM text_units WHERE project_file_id = ANY($1::text[]);

-- name: GetFilesWithMetadataFromTextUnitIDs :many
-- Intentionally resolves only direct text_units.id values.
-- Legacy entity_sources/relationship_sources fallback was removed on purpose.
WITH project_scope AS (
    SELECT sqlc.arg(project_id)::text AS project_id
),
project_files_scope AS (
    SELECT pf.id
    FROM project_files pf
    JOIN project_scope ps ON ps.project_id = pf.project_id
),
input_ids AS (
    SELECT DISTINCT trim(u.pid) AS pid
    FROM unnest(sqlc.arg(source_ids)::text[]) AS u(pid)
    WHERE trim(u.pid) <> ''
),
resolved_text_units AS (
    SELECT tu.id, tu.project_file_id
    FROM input_ids i
    JOIN text_units tu ON tu.id = i.pid
    JOIN project_files_scope pfs ON pfs.id = tu.project_file_id
)
SELECT DISTINCT f.name, f.file_key, f.metadata, rtu.id
FROM resolved_text_units rtu
JOIN project_files f ON f.id = rtu.project_file_id
JOIN project_scope ps ON ps.project_id = f.project_id;
