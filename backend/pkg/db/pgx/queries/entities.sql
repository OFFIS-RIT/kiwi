-- name: GetProjectEntities :many
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.project_id = $1;

-- name: GetEntityIDsByPublicIDs :many
SELECT e.id, e.public_id
FROM entities e
WHERE e.project_id = sqlc.arg(project_id) AND e.public_id = ANY(sqlc.arg(public_ids)::text[]);

-- name: UpsertProjectEntities :many
WITH input AS (
    SELECT
        u.public_id,
        (sqlc.arg(names)::text[])[u.ord]::text AS name,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(types)::text[])[u.ord]::text AS type,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(public_ids)::text[]) WITH ORDINALITY AS u(public_id, ord)
)
INSERT INTO entities (public_id, project_id, name, description, type, embedding)
SELECT public_id, sqlc.arg(project_id)::bigint, name, description, type, embedding
FROM input
ON CONFLICT (public_id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    type = EXCLUDED.type,
    embedding = EXCLUDED.embedding,
    updated_at = NOW()
RETURNING id, public_id;

-- name: GetProjectEntityByID :one
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.id = $1;

-- name: GetProjectEntitiesByNames :many
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.project_id = $1 AND e.name = ANY($2::text[]);

-- name: GetProjectEntityNames :many
SELECT DISTINCT e.name FROM entities e WHERE e.project_id = $1;

-- name: GetProjectEntitiesByIDs :many
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.id = ANY($1::bigint[]);

-- name: UpdateProjectEntity :one
UPDATE entities SET description = $2, embedding = $3, updated_at = NOW() WHERE public_id = $1 RETURNING id;

-- name: DeleteProjectEntity :exec
DELETE FROM entities WHERE id = $1;

-- name: UpdateEntityName :exec
UPDATE entities SET name = $2, updated_at = NOW() WHERE id = $1;

-- name: UpsertEntitySources :exec
WITH input AS (
    SELECT
        u.public_id,
        (sqlc.arg(entity_ids)::bigint[])[u.ord]::bigint AS entity_id,
        (sqlc.arg(text_unit_ids)::bigint[])[u.ord]::bigint AS text_unit_id,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(public_ids)::text[]) WITH ORDINALITY AS u(public_id, ord)
)
INSERT INTO entity_sources (public_id, entity_id, text_unit_id, description, embedding)
SELECT public_id, entity_id, text_unit_id, description, embedding
FROM input
ON CONFLICT (public_id) DO UPDATE
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

-- name: SearchEntitiesByType :many
SELECT e.id, e.name, e.type, e.description
FROM entities e
WHERE e.project_id = $1 AND e.type = $2
ORDER BY e.embedding <=> $3
LIMIT $4;

-- name: FindEntitiesWithSimilarNames :many
SELECT e1.id as id1, e1.public_id as public_id1, e1.name as name1, e1.type as type1,
       e2.id as id2, e2.public_id as public_id2, e2.name as name2, e2.type as type2
FROM entities e1
JOIN entities e2 ON similarity(e1.name, e2.name) > 0.5 AND e1.type = e2.type AND e2.project_id = $1
WHERE e1.id < e2.id AND e1.project_id = $1 AND e1.type NOT IN ('FACT', 'FILE');

-- name: FindEntitiesWithSimilarNamesForEntityIDs :many
WITH seed AS (
    SELECT e.id, e.public_id, e.name, e.type
    FROM entities e
    WHERE e.project_id = sqlc.arg(project_id)
      AND e.id = ANY(sqlc.arg(entity_ids)::bigint[])
      AND e.type NOT IN ('FACT', 'FILE')
)
SELECT e1.id as id1, e1.public_id as public_id1, e1.name as name1, e1.type as type1,
       e2.id as id2, e2.public_id as public_id2, e2.name as name2, e2.type as type2
FROM seed e1
JOIN entities e2 ON similarity(e1.name, e2.name) > 0.5
    AND e1.type = e2.type
    AND e2.project_id = sqlc.arg(project_id)
WHERE e1.id < e2.id
UNION ALL
SELECT e1.id as id1, e1.public_id as public_id1, e1.name as name1, e1.type as type1,
       e2.id as id2, e2.public_id as public_id2, e2.name as name2, e2.type as type2
FROM entities e1
JOIN seed e2 ON similarity(e1.name, e2.name) > 0.5
    AND e1.type = e2.type
    AND e1.project_id = sqlc.arg(project_id)
WHERE e1.id < e2.id
  AND e1.id <> ALL(sqlc.arg(entity_ids)::bigint[]);

-- name: TransferEntitySources :exec
UPDATE entity_sources SET entity_id = $2 WHERE entity_id = $1;

-- name: CountEntitySources :one
SELECT COUNT(*)::int FROM entity_sources WHERE entity_id = $1;

-- name: DeleteEntitiesWithoutSources :exec
DELETE FROM entities 
WHERE project_id = $1 
  AND id NOT IN (SELECT DISTINCT entity_id FROM entity_sources);

-- name: GetEntitySourceDescriptionsBatch :many
SELECT es.id, es.description
FROM entity_sources es
WHERE es.entity_id = $1
  AND es.id > $2
ORDER BY es.id
LIMIT $3;

-- name: GetEntitySourceDescriptionsForFilesBatch :many
SELECT es.id, es.description
FROM entity_sources es
JOIN text_units tu ON tu.id = es.text_unit_id
WHERE es.entity_id = $1
  AND tu.project_file_id = ANY($2::bigint[])
  AND es.id > $3
ORDER BY es.id
LIMIT $4;

-- name: GetEntitiesWithSourcesFromUnits :many
SELECT DISTINCT e.id, e.public_id, e.name, e.type, e.description
FROM entities e
JOIN entity_sources es ON es.entity_id = e.id
WHERE es.text_unit_id = ANY($1::bigint[])
  AND e.project_id = $2;

-- name: GetEntitiesWithSourcesFromFiles :many
SELECT DISTINCT e.id, e.public_id, e.name, e.type, e.description
FROM entities e
JOIN entity_sources es ON es.entity_id = e.id
JOIN text_units tu ON tu.id = es.text_unit_id
WHERE tu.project_file_id = ANY($1::bigint[])
  AND e.project_id = $2;

-- name: UpdateProjectEntitiesByIDs :exec
WITH input AS (
    SELECT
        u.id,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(ids)::bigint[]) WITH ORDINALITY AS u(id, ord)
)
UPDATE entities e
SET description = input.description,
    embedding = input.embedding,
    updated_at = NOW()
FROM input
WHERE e.id = input.id;
