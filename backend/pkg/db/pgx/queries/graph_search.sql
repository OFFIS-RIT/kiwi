-- name: FindSimilarEntities :many
SELECT e.id
FROM entities e
WHERE e.project_id = $1
    AND (e.embedding <=> $2) < $4::double precision
ORDER BY e.embedding <=> $2
LIMIT $3;

-- name: FindRelevantSourcesForEntities :many
SELECT
    s.id,
    u.public_id,
    s.entity_id,
    s.description
FROM entity_sources s
JOIN text_units u ON u.id = s.text_unit_id
WHERE s.entity_id = ANY($1::bigint[])
ORDER BY s.embedding <=> $2
LIMIT $3;

-- name: FindRelevantSourcesForRelations :many
SELECT
    s.id,
    u.public_id,
    s.description,
    r.source_id,
    r.target_id
FROM relationship_sources s
JOIN text_units u ON u.id = s.text_unit_id
JOIN relationships r ON r.id = s.relationship_id
WHERE s.relationship_id = ANY($1::bigint[])
ORDER BY s.embedding <=> $2
LIMIT $3;

-- name: FindSimilarEntitySources :many
SELECT s.id, s.public_id, s.description, u.public_id, e.name FROM entity_sources s
JOIN text_units u ON u.id = s.text_unit_id
JOIN entities e ON e.id = s.entity_id
WHERE (s.embedding <=> $1) < $4::double precision
    AND e.project_id = $2
ORDER BY s.embedding <=> $1
LIMIT $3;

-- name: FindRelevantEntitySources :many
SELECT s.id, s.public_id, s.description, u.public_id, e.name FROM entity_sources s
JOIN text_units u ON u.id = s.text_unit_id
JOIN entities e ON e.id = s.entity_id
WHERE s.entity_id = ANY($1::bigint[])
    AND (s.embedding <=> $2) < $4::double precision
ORDER BY s.embedding <=> $2
LIMIT $3;

-- name: FindRelevantRelationSources :many
SELECT s.id, s.public_id, s.description, u.public_id, se.name, te.name, r.rank FROM relationship_sources s
JOIN text_units u ON u.id = s.text_unit_id
JOIN relationships r ON r.id = s.relationship_id
JOIN entities se ON r.source_id = se.id
JOIN entities te ON r.target_id = te.id
WHERE s.relationship_id = ANY ($1::bigint[])
    AND (s.embedding <=> $2) < $4::double precision
ORDER BY s.embedding <=> $2
LIMIT $3;

-- name: SearchEntitiesByEmbedding :many
SELECT e.id, e.name, e.type, e.description
FROM entities e
WHERE e.project_id = $1
ORDER BY e.embedding <=> $2
LIMIT $3;

-- name: SearchRelationshipsByEmbedding :many
SELECT 
    r.id,
    r.description,
    r.rank,
    r.source_id,
    r.target_id,
    se.name as source_name,
    se.type as source_type,
    te.name as target_name,
    te.type as target_type
FROM relationships r
JOIN entities se ON r.source_id = se.id
JOIN entities te ON r.target_id = te.id
WHERE r.project_id = $1
ORDER BY r.embedding <=> $2
LIMIT $3;

-- name: GetRelationshipsByIDs :many
SELECT 
    r.id,
    r.description,
    r.rank,
    r.source_id,
    r.target_id,
    se.name as source_name,
    se.type as source_type,
    te.name as target_name,
    te.type as target_type
FROM relationships r
JOIN entities se ON r.source_id = se.id
JOIN entities te ON r.target_id = te.id
WHERE r.id = ANY($1::bigint[]);

-- name: GetEntityNeighboursRanked :many
SELECT 
    r.id as relationship_id,
    r.description as relationship_description,
    r.rank,
    r.source_id,
    r.target_id,
    e.id as neighbour_id,
    e.name as neighbour_name,
    e.type as neighbour_type,
    e.description as neighbour_description
FROM relationships r
JOIN entities e 
    ON e.id = CASE 
        WHEN r.source_id = $1 THEN r.target_id
        ELSE r.source_id
    END
WHERE $1 IN (r.source_id, r.target_id)
ORDER BY r.embedding <=> $2
LIMIT $3;
