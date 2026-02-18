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
SELECT p.id FROM graphs p
JOIN project_files f ON f.project_id = p.id
JOIN text_units tu ON tu.project_file_id = f.id
WHERE tu.public_id = $1;

-- name: GetFilesFromTextUnitIDs :many
WITH input_ids AS (
    SELECT DISTINCT trim(u.pid) AS pid
    FROM unnest($1::text[]) AS u(pid)
    WHERE trim(u.pid) <> ''
),
numeric_ids AS (
    SELECT pid, pid::bigint AS id
    FROM input_ids
    WHERE pid ~ '^[0-9]+$'
),
resolved_text_units AS (
    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM input_ids i
    JOIN text_units tu ON tu.public_id = i.pid

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM input_ids i
    JOIN entity_sources es ON es.public_id = i.pid
    JOIN text_units tu ON tu.id = es.text_unit_id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM input_ids i
    JOIN relationship_sources rs ON rs.public_id = i.pid
    JOIN text_units tu ON tu.id = rs.text_unit_id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM numeric_ids n
    JOIN text_units tu ON tu.id = n.id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM numeric_ids n
    JOIN entity_sources es ON es.id = n.id
    JOIN text_units tu ON tu.id = es.text_unit_id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM numeric_ids n
    JOIN relationship_sources rs ON rs.id = n.id
    JOIN text_units tu ON tu.id = rs.text_unit_id
)
SELECT DISTINCT f.name, f.file_key, rtu.public_id
FROM resolved_text_units rtu
JOIN project_files f ON f.id = rtu.project_file_id;

-- name: DeleteTextUnitsByFileIDs :exec
DELETE FROM text_units WHERE project_file_id = ANY($1::bigint[]);

-- name: GetFilesWithMetadataFromTextUnitIDs :many
WITH input_ids AS (
    SELECT DISTINCT trim(u.pid) AS pid
    FROM unnest($1::text[]) AS u(pid)
    WHERE trim(u.pid) <> ''
),
numeric_ids AS (
    SELECT pid, pid::bigint AS id
    FROM input_ids
    WHERE pid ~ '^[0-9]+$'
),
resolved_text_units AS (
    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM input_ids i
    JOIN text_units tu ON tu.public_id = i.pid

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM input_ids i
    JOIN entity_sources es ON es.public_id = i.pid
    JOIN text_units tu ON tu.id = es.text_unit_id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM input_ids i
    JOIN relationship_sources rs ON rs.public_id = i.pid
    JOIN text_units tu ON tu.id = rs.text_unit_id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM numeric_ids n
    JOIN text_units tu ON tu.id = n.id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM numeric_ids n
    JOIN entity_sources es ON es.id = n.id
    JOIN text_units tu ON tu.id = es.text_unit_id

    UNION

    SELECT tu.id, tu.public_id, tu.project_file_id
    FROM numeric_ids n
    JOIN relationship_sources rs ON rs.id = n.id
    JOIN text_units tu ON tu.id = rs.text_unit_id
)
SELECT DISTINCT f.name, f.file_key, f.metadata, rtu.public_id
FROM resolved_text_units rtu
JOIN project_files f ON f.id = rtu.project_file_id;
