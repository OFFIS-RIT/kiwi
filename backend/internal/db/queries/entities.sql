-- name: AddProjectEntity :one
INSERT INTO entities (public_id, project_id, name, description, type, embedding)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING id;

-- name: GetProjectEntities :many
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.project_id = $1;

-- name: GetProjectEntityByNameSimilarity :one
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e
WHERE e.project_id = $1
ORDER BY similarity(e.name, $2) DESC
LIMIT 1;

-- name: GetProjectEntityByPublicID :one
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.public_id = $1;

-- name: GetProjectEntityByID :one
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.id = $1;

-- name: GetProjectEntityByName :one
SELECT e.id, e.public_id, e.name, e.description, e.type FROM entities e WHERE e.project_id = $1 AND e.name = $2;

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

-- name: DeleteProjectEntityByPublicID :exec
DELETE FROM entities WHERE public_id = $1;

-- name: GetProjectEntityWithSourcesFromUnitID :many
SELECT  pe.id, pe.public_id, pe.name, pe.description, pe.type, pes.id, pes.public_id, pes.text_unit_id, pes.entity_id, pes.description
FROM entities pe
JOIN entity_sources pes 
    ON pes.entity_id = pe.id
WHERE pe.id = (
    SELECT pes2.entity_id
    FROM entity_sources pes2
    WHERE pes2.text_unit_id = $1
);

-- name: AddProjectEntitySource :one
INSERT INTO entity_sources (public_id, entity_id, text_unit_id, description, embedding)
VALUES ($1, $2, $3, $4, $5) RETURNING id;

-- name: GetProjectEntitySourcesByPublicID :many
SELECT ps.public_id, ps.description FROM entity_sources ps
JOIN entities pe ON ps.entity_id = pe.id
WHERE pe.public_id = $1;

-- name: DeleteEntitySources :exec
DELETE FROM entity_sources WHERE entity_id = $1;

-- name: GetMinProjectEntities :many
SELECT id, public_id, name, type, description
FROM entities 
WHERE project_id = $1;

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
WHERE e1.id < e2.id AND e1.project_id = $1;

-- name: TransferEntitySources :exec
UPDATE entity_sources SET entity_id = $2 WHERE entity_id = $1;

-- name: CountEntitySources :one
SELECT COUNT(*)::int FROM entity_sources WHERE entity_id = $1;

-- name: DeleteEntitiesWithoutSources :exec
DELETE FROM entities 
WHERE project_id = $1 
  AND id NOT IN (SELECT DISTINCT entity_id FROM entity_sources);

-- name: GetAllEntitySourceDescriptions :many
SELECT es.id, es.description, es.text_unit_id
FROM entity_sources es
WHERE es.entity_id = $1;

-- name: GetEntitiesWithSourcesFromUnits :many
SELECT DISTINCT e.id, e.public_id, e.name, e.type, e.description
FROM entities e
JOIN entity_sources es ON es.entity_id = e.id
WHERE es.text_unit_id = ANY($1::bigint[])
  AND e.project_id = $2;

-- name: CountEntitySourcesFromUnits :one
SELECT COUNT(*)::int 
FROM entity_sources es
WHERE es.entity_id = $1 
  AND es.text_unit_id = ANY($2::bigint[]);

-- name: UpdateProjectEntityByID :one
UPDATE entities SET description = $2, embedding = $3, updated_at = NOW() WHERE id = $1 RETURNING id;
