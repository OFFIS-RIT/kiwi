-- name: UpsertProjectRelationships :many
WITH input AS (
    SELECT
        u.public_id,
        (sqlc.arg(source_ids)::bigint[])[u.ord]::bigint AS source_id,
        (sqlc.arg(target_ids)::bigint[])[u.ord]::bigint AS target_id,
        (sqlc.arg(ranks)::float8[])[u.ord]::float8 AS rank,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(public_ids)::text[]) WITH ORDINALITY AS u(public_id, ord)
)
INSERT INTO relationships (public_id, project_id, source_id, target_id, rank, description, embedding)
SELECT public_id, sqlc.arg(project_id)::bigint, source_id, target_id, rank, description, embedding
FROM input
ON CONFLICT (public_id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    source_id = EXCLUDED.source_id,
    target_id = EXCLUDED.target_id,
    rank = EXCLUDED.rank,
    description = EXCLUDED.description,
    embedding = EXCLUDED.embedding,
    updated_at = NOW()
RETURNING id, public_id;

-- name: GetProjectRelationships :many
SELECT r.id, r.public_id, r.source_id, r.target_id, r.description, r.rank FROM relationships r WHERE r.project_id = $1;

-- name: GetProjectRelationshipsWithEntityNamesByIDs :many
SELECT r.id, r.public_id, r.source_id, r.target_id, r.description, r.rank,
       se.name AS source_name,
       te.name AS target_name
FROM relationships r
JOIN entities se ON r.source_id = se.id
JOIN entities te ON r.target_id = te.id
WHERE r.id = ANY(sqlc.arg(ids)::bigint[]);

-- name: UpdateProjectRelationship :one
UPDATE relationships SET description = $2, rank = $3, embedding = $4, updated_at = NOW() WHERE public_id = $1 RETURNING id;

-- name: DeleteProjectRelationshipsByIDs :exec
DELETE FROM relationships
WHERE project_id = sqlc.arg(project_id)
  AND id = ANY(sqlc.arg(ids)::bigint[]);

-- name: UpsertRelationshipSources :exec
WITH input AS (
    SELECT
        u.public_id,
        (sqlc.arg(relationship_ids)::bigint[])[u.ord]::bigint AS relationship_id,
        (sqlc.arg(text_unit_ids)::bigint[])[u.ord]::bigint AS text_unit_id,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(public_ids)::text[]) WITH ORDINALITY AS u(public_id, ord)
)
INSERT INTO relationship_sources (public_id, relationship_id, text_unit_id, description, embedding)
SELECT public_id, relationship_id, text_unit_id, description, embedding
FROM input
ON CONFLICT (public_id) DO UPDATE
SET relationship_id = EXCLUDED.relationship_id,
    text_unit_id = EXCLUDED.text_unit_id,
    description = EXCLUDED.description,
    embedding = EXCLUDED.embedding,
    updated_at = NOW();

-- name: UpdateRelationshipSourceEntitiesBatch :exec
UPDATE relationships
SET source_id = sqlc.arg(canonical_id)
WHERE project_id = sqlc.arg(project_id)
  AND source_id = ANY(sqlc.arg(entity_ids)::bigint[]);

-- name: UpdateRelationshipTargetEntitiesBatch :exec
UPDATE relationships
SET target_id = sqlc.arg(canonical_id)
WHERE project_id = sqlc.arg(project_id)
  AND target_id = ANY(sqlc.arg(entity_ids)::bigint[]);

-- name: TransferRelationshipSourcesBatchByMappings :exec
WITH input AS (
    SELECT
        rel.relationship_id,
        (sqlc.arg(canonical_ids)::bigint[])[rel.ord]::bigint AS canonical_id
    FROM unnest(sqlc.arg(relationship_ids)::bigint[]) WITH ORDINALITY AS rel(relationship_id, ord)
)
UPDATE relationship_sources rs
SET relationship_id = input.canonical_id
FROM input
JOIN relationships r ON r.id = input.relationship_id
WHERE rs.relationship_id = input.relationship_id
  AND r.project_id = sqlc.arg(project_id);

-- name: UpdateProjectRelationshipRanksByIDs :exec
WITH input AS (
    SELECT
        rel.id,
        (sqlc.arg(ranks)::float8[])[rel.ord]::float8 AS rank
    FROM unnest(sqlc.arg(ids)::bigint[]) WITH ORDINALITY AS rel(id, ord)
)
UPDATE relationships r
SET rank = input.rank,
    updated_at = NOW()
FROM input
WHERE r.id = input.id
  AND r.project_id = sqlc.arg(project_id);

-- name: DeleteRelationshipsWithoutSources :exec
DELETE FROM relationships 
WHERE project_id = $1 
  AND id NOT IN (SELECT DISTINCT relationship_id FROM relationship_sources);

-- name: GetRelationshipSourceDescriptionsBatch :many
SELECT rs.id, rs.description
FROM relationship_sources rs
WHERE rs.relationship_id = $1
  AND rs.id > $2
ORDER BY rs.id
LIMIT $3;

-- name: GetRelationshipSourceDescriptionsForFilesBatch :many
SELECT rs.id, rs.description
FROM relationship_sources rs
JOIN text_units tu ON tu.id = rs.text_unit_id
WHERE rs.relationship_id = $1
  AND tu.project_file_id = ANY($2::bigint[])
  AND rs.id > $3
ORDER BY rs.id
LIMIT $4;

-- name: GetRelationshipsWithSourcesFromUnits :many
SELECT DISTINCT r.id, r.public_id, r.source_id, r.target_id, r.description, r.rank
FROM relationships r
JOIN relationship_sources rs ON rs.relationship_id = r.id
WHERE rs.text_unit_id = ANY($1::bigint[])
  AND r.project_id = $2;

-- name: GetRelationshipsWithSourcesFromFiles :many
SELECT DISTINCT r.id, r.public_id, r.source_id, r.target_id, r.description, r.rank
FROM relationships r
JOIN relationship_sources rs ON rs.relationship_id = r.id
JOIN text_units tu ON tu.id = rs.text_unit_id
WHERE tu.project_file_id = ANY($1::bigint[])
  AND r.project_id = $2;

-- name: UpdateProjectRelationshipsByIDs :exec
WITH input AS (
    SELECT
        u.id,
        (sqlc.arg(descriptions)::text[])[u.ord]::text AS description,
        (sqlc.arg(embeddings)::vector[])[u.ord]::vector AS embedding
    FROM unnest(sqlc.arg(ids)::bigint[]) WITH ORDINALITY AS u(id, ord)
)
UPDATE relationships r
SET description = input.description,
    embedding = input.embedding,
    updated_at = NOW()
FROM input
WHERE r.id = input.id;
