-- name: GetProjectEntities :many
SELECT e.id, e.name, e.description, e.type FROM entities e WHERE e.project_id = $1;

-- name: UpsertProjectEntities :many
WITH input AS (
    SELECT
        u.id,
        (sqlc.arg(names)::text[])[u.ord]::text AS name,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(types)::text[])[u.ord]::text AS type,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(ids)::text[]) WITH ORDINALITY AS u(id, ord)
)
INSERT INTO entities (id, project_id, name, description, type, embedding)
SELECT id, sqlc.arg(project_id)::text, name, description, type, embedding
FROM input
ON CONFLICT (id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    type = EXCLUDED.type,
    embedding = EXCLUDED.embedding,
    updated_at = NOW()
RETURNING id;

-- name: GetProjectEntityByID :one
SELECT e.id, e.name, e.description, e.type FROM entities e WHERE e.id = $1;

-- name: GetProjectEntitiesByNames :many
SELECT e.id, e.name, e.description, e.type FROM entities e WHERE e.project_id = $1 AND e.name = ANY($2::text[]);

-- name: GetProjectEntityNames :many
SELECT DISTINCT e.name FROM entities e WHERE e.project_id = $1;

-- name: GetProjectEntitiesByIDs :many
SELECT e.id, e.name, e.description, e.type FROM entities e WHERE e.id = ANY($1::text[]);

-- name: GetProjectEntitiesByIDsForUpdate :many
SELECT e.id, e.name, e.description, e.type
FROM entities e
WHERE e.project_id = sqlc.arg(project_id)
  AND e.id = ANY(sqlc.arg(ids)::text[])
ORDER BY e.id
FOR UPDATE;

-- name: GetProjectEntitiesWithSourceCountsByIDs :many
SELECT e.id, e.name, e.description, e.type,
       COUNT(es.id)::bigint AS source_count
FROM entities e
LEFT JOIN entity_sources es ON es.entity_id = e.id
WHERE e.project_id = sqlc.arg(project_id)
  AND e.id = ANY(sqlc.arg(ids)::text[])
GROUP BY e.id, e.name, e.description, e.type;

-- name: UpdateProjectEntity :one
UPDATE entities SET description = $2, embedding = $3, updated_at = NOW() WHERE id = $1 RETURNING id;

-- name: UpdateEntityName :exec
UPDATE entities
SET name = sqlc.arg(name), updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND project_id = sqlc.arg(project_id);

-- name: UpsertEntitySources :exec
WITH input AS (
    SELECT
        u.id,
        (sqlc.arg(entity_ids)::text[])[u.ord]::text AS entity_id,
        (sqlc.arg(text_unit_ids)::text[])[u.ord]::text AS text_unit_id,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(ids)::text[]) WITH ORDINALITY AS u(id, ord)
)
INSERT INTO entity_sources (id, entity_id, text_unit_id, description, embedding)
SELECT id, entity_id, text_unit_id, description, embedding
FROM input
ON CONFLICT (id) DO UPDATE
SET entity_id = EXCLUDED.entity_id,
    text_unit_id = EXCLUDED.text_unit_id,
    description = EXCLUDED.description,
    embedding = EXCLUDED.embedding,
    updated_at = NOW();

-- name: GetEntityTypes :many
SELECT e.type, COUNT(*) as count
FROM entities e
WHERE e.project_id = $1
GROUP BY e.type
ORDER BY count DESC;

-- name: FindEntitiesWithSimilarNames :many
SELECT e1.id as id1, e1.name as name1, e1.type as type1,
       e2.id as id2, e2.name as name2, e2.type as type2
FROM entities e1
JOIN entities e2 ON e2.project_id = $1
    AND e1.type = e2.type
    AND e2.type NOT IN ('FACT', 'FILE')
    AND e2.name % e1.name
    AND similarity(e1.name, e2.name) > 0.5
WHERE e1.id < e2.id AND e1.project_id = $1 AND e1.type NOT IN ('FACT', 'FILE');

-- name: FindEntitiesWithSimilarNamesForEntityIDs :many
WITH seed AS (
    SELECT e.id, e.name, e.type
    FROM entities e
    WHERE e.project_id = sqlc.arg(project_id)
      AND e.id = ANY(sqlc.arg(entity_ids)::text[])
      AND e.type NOT IN ('FACT', 'FILE')
)
SELECT DISTINCT ON (
    LEAST(seed.id, candidate.id),
    GREATEST(seed.id, candidate.id)
)
    LEAST(seed.id, candidate.id)::text as id1,
    (CASE WHEN seed.id < candidate.id THEN seed.name ELSE candidate.name END)::text as name1,
    (CASE WHEN seed.id < candidate.id THEN seed.type ELSE candidate.type END)::text as type1,
    GREATEST(seed.id, candidate.id)::text as id2,
    (CASE WHEN seed.id < candidate.id THEN candidate.name ELSE seed.name END)::text as name2,
    (CASE WHEN seed.id < candidate.id THEN candidate.type ELSE seed.type END)::text as type2
FROM seed
JOIN entities candidate ON candidate.project_id = sqlc.arg(project_id)
    AND candidate.type = seed.type
    AND candidate.type NOT IN ('FACT', 'FILE')
    AND candidate.id <> seed.id
    AND candidate.name % seed.name
    AND similarity(candidate.name, seed.name) > 0.5
ORDER BY LEAST(seed.id, candidate.id), GREATEST(seed.id, candidate.id);

-- name: TransferEntitySourcesBatch :exec
UPDATE entity_sources es
SET entity_id = sqlc.arg(canonical_id)
FROM entities e
WHERE es.entity_id = e.id
  AND e.project_id = sqlc.arg(project_id)
  AND es.entity_id = ANY(sqlc.arg(entity_ids)::text[]);

-- name: DeleteEntitiesWithoutSources :exec
DELETE FROM entities 
WHERE project_id = $1 
  AND id NOT IN (SELECT DISTINCT entity_id FROM entity_sources);

-- name: DeleteProjectEntitiesByIDs :exec
DELETE FROM entities
WHERE project_id = sqlc.arg(project_id)
  AND id = ANY(sqlc.arg(ids)::text[]);

-- name: GetEntitySourceDescriptionsBatch :many
SELECT es.id, es.created_at, es.description
FROM entity_sources es
WHERE es.entity_id = sqlc.arg(entity_id)
  AND (
      es.created_at > sqlc.arg(cursor_created_at)
      OR (es.created_at = sqlc.arg(cursor_created_at) AND es.id > sqlc.arg(cursor_id))
  )
ORDER BY es.created_at, es.id
LIMIT sqlc.arg(batch_limit);

-- name: GetEntitySourceDescriptionsForFilesBatch :many
SELECT es.id, es.created_at, es.description
FROM entity_sources es
JOIN text_units tu ON tu.id = es.text_unit_id
WHERE es.entity_id = sqlc.arg(entity_id)
  AND tu.project_file_id = ANY(sqlc.arg(file_ids)::text[])
  AND (
      es.created_at > sqlc.arg(cursor_created_at)
      OR (es.created_at = sqlc.arg(cursor_created_at) AND es.id > sqlc.arg(cursor_id))
  )
ORDER BY es.created_at, es.id
LIMIT sqlc.arg(batch_limit);

-- name: GetEntitiesWithSourcesFromUnits :many
SELECT DISTINCT e.id, e.name, e.type, e.description
FROM entities e
JOIN entity_sources es ON es.entity_id = e.id
WHERE es.text_unit_id = ANY($1::text[])
  AND e.project_id = $2;

-- name: GetEntitiesWithSourcesFromFiles :many
SELECT DISTINCT e.id, e.name, e.type, e.description
FROM entities e
JOIN entity_sources es ON es.entity_id = e.id
JOIN text_units tu ON tu.id = es.text_unit_id
WHERE tu.project_file_id = ANY($1::text[])
  AND e.project_id = $2;

-- name: UpdateProjectEntitiesByIDs :exec
WITH input AS (
    SELECT
        u.id,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(ids)::text[]) WITH ORDINALITY AS u(id, ord)
)
UPDATE entities e
SET description = input.description,
    embedding = input.embedding,
    updated_at = NOW()
FROM input
WHERE e.id = input.id;

-- name: GetEntitySourceCountsByIDs :many
SELECT e.id, COUNT(es.id)::int AS source_count
FROM entities e
LEFT JOIN entity_sources es ON es.entity_id = e.id
WHERE e.id = ANY($1::text[])
  AND e.project_id = $2
GROUP BY e.id;
