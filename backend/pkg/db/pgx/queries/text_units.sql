-- name: GetTextUnitIdsForFiles :many
SELECT id, public_id FROM text_units WHERE project_file_id = ANY($1::bigint[]);

-- name: GetTextUnitByPublicId :one
SELECT * FROM text_units
WHERE public_id = $1;

-- name: GetTextUnitIDsByPublicIDs :many
SELECT id, public_id
FROM text_units
WHERE public_id = ANY(sqlc.arg(public_ids)::text[]);

-- name: UpsertTextUnits :many
WITH input AS (
    SELECT
        u.public_id,
        (sqlc.arg(project_file_ids)::bigint[])[u.ord]::bigint AS project_file_id,
        (sqlc.arg(texts)::text[])[u.ord]::text AS text
    FROM unnest(sqlc.arg(public_ids)::text[]) WITH ORDINALITY AS u(public_id, ord)
)
INSERT INTO text_units (public_id, project_file_id, text)
SELECT public_id, project_file_id, text
FROM input
ON CONFLICT (public_id) DO UPDATE
SET project_file_id = EXCLUDED.project_file_id,
    text = EXCLUDED.text,
    updated_at = NOW()
RETURNING id;

-- name: GetProjectIDFromTextUnit :one
SELECT p.id FROM projects p
JOIN project_files f ON f.project_id = p.id
JOIN text_units tu ON tu.project_file_id = f.id
WHERE tu.public_id = $1;

-- name: GetFilesFromTextUnitIDs :many
SELECT f.name, f.file_key, tu.public_id FROM project_files f
JOIN text_units tu
    ON tu.project_file_id = f.id
JOIN unnest($1::text[]) AS u(pid)
    ON tu.public_id = u.pid;

-- name: DeleteTextUnitsByFileIDs :exec
DELETE FROM text_units WHERE project_file_id = ANY($1::bigint[]);

-- name: GetFilesWithMetadataFromTextUnitIDs :many
SELECT f.name, f.file_key, f.metadata, tu.public_id 
FROM project_files f
JOIN text_units tu ON tu.project_file_id = f.id
JOIN unnest($1::text[]) AS u(pid) ON tu.public_id = u.pid;
