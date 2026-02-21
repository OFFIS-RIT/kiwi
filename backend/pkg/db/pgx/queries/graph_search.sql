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

-- name: SearchEntitiesByEmbeddingWithKeywords :many
WITH semantic_candidates AS (
    SELECT e.id
    FROM entities e
    WHERE e.project_id = sqlc.arg(project_id)
    ORDER BY e.embedding <=> sqlc.arg(embedding)
    LIMIT sqlc.arg(candidate_limit)
),
keyword_candidates AS (
    SELECT e.id
    FROM entities e
    WHERE e.project_id = sqlc.arg(project_id)
      AND COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0
      AND e.search_tsv @@ plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))
    ORDER BY ts_rank_cd(e.search_tsv, plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))) DESC,
             e.id
    LIMIT sqlc.arg(candidate_limit)
),
candidates AS (
    SELECT id FROM semantic_candidates
    UNION
    SELECT id FROM keyword_candidates
)
SELECT
    e.id,
    e.name,
    e.type,
    e.description,
    (e.embedding <=> sqlc.arg(embedding))::double precision AS semantic_distance,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN
            ts_rank_cd(e.search_tsv, plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' ')))
        ELSE 0
    END::double precision AS keyword_rank,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN (
            SELECT COUNT(*)::int
            FROM unnest(sqlc.arg(keywords)::text[]) AS kw
            WHERE kw <> ''
              AND position(lower(kw) in lower(e.name || ' ' || e.description)) > 0
        )
        ELSE 0
    END::int AS keyword_matches,
    COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0)::int AS keyword_total
FROM candidates c
JOIN entities e ON e.id = c.id
ORDER BY semantic_distance ASC, e.id
LIMIT sqlc.arg(candidate_limit);

-- name: SearchEntitiesByTypeWithKeywords :many
WITH semantic_candidates AS (
    SELECT e.id
    FROM entities e
    WHERE e.project_id = sqlc.arg(project_id)
      AND e.type = sqlc.arg(type)
    ORDER BY e.embedding <=> sqlc.arg(embedding)
    LIMIT sqlc.arg(candidate_limit)
),
keyword_candidates AS (
    SELECT e.id
    FROM entities e
    WHERE e.project_id = sqlc.arg(project_id)
      AND e.type = sqlc.arg(type)
      AND COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0
      AND e.search_tsv @@ plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))
    ORDER BY ts_rank_cd(e.search_tsv, plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))) DESC,
             e.id
    LIMIT sqlc.arg(candidate_limit)
),
candidates AS (
    SELECT id FROM semantic_candidates
    UNION
    SELECT id FROM keyword_candidates
)
SELECT
    e.id,
    e.name,
    e.type,
    e.description,
    (e.embedding <=> sqlc.arg(embedding))::double precision AS semantic_distance,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN
            ts_rank_cd(e.search_tsv, plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' ')))
        ELSE 0
    END::double precision AS keyword_rank,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN (
            SELECT COUNT(*)::int
            FROM unnest(sqlc.arg(keywords)::text[]) AS kw
            WHERE kw <> ''
              AND position(lower(kw) in lower(e.name || ' ' || e.description)) > 0
        )
        ELSE 0
    END::int AS keyword_matches,
    COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0)::int AS keyword_total
FROM candidates c
JOIN entities e ON e.id = c.id
ORDER BY semantic_distance ASC, e.id
LIMIT sqlc.arg(candidate_limit);

-- name: SearchRelationshipsByEmbeddingWithKeywords :many
WITH semantic_candidates AS (
    SELECT r.id
    FROM relationships r
    WHERE r.project_id = sqlc.arg(project_id)
    ORDER BY r.embedding <=> sqlc.arg(embedding)
    LIMIT sqlc.arg(candidate_limit)
),
keyword_candidates AS (
    SELECT r.id
    FROM relationships r
    WHERE r.project_id = sqlc.arg(project_id)
      AND COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0
      AND r.search_tsv @@ plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))
    ORDER BY ts_rank_cd(r.search_tsv, plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))) DESC,
             r.id
    LIMIT sqlc.arg(candidate_limit)
),
candidates AS (
    SELECT id FROM semantic_candidates
    UNION
    SELECT id FROM keyword_candidates
)
SELECT
    r.id,
    r.description,
    r.rank,
    r.source_id,
    r.target_id,
    se.name as source_name,
    se.type as source_type,
    te.name as target_name,
    te.type as target_type,
    (r.embedding <=> sqlc.arg(embedding))::double precision AS semantic_distance,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN
            ts_rank_cd(r.search_tsv, plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' ')))
        ELSE 0
    END::double precision AS keyword_rank,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN (
            SELECT COUNT(*)::int
            FROM unnest(sqlc.arg(keywords)::text[]) AS kw
            WHERE kw <> ''
              AND position(lower(kw) in lower(se.name || ' ' || te.name || ' ' || r.description)) > 0
        )
        ELSE 0
    END::int AS keyword_matches,
    COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0)::int AS keyword_total
FROM candidates c
JOIN relationships r ON r.id = c.id
JOIN entities se ON r.source_id = se.id
JOIN entities te ON r.target_id = te.id
ORDER BY semantic_distance ASC, r.id
LIMIT sqlc.arg(candidate_limit);

-- name: GetEntityNeighboursRankedWithKeywords :many
WITH semantic_candidates AS (
    SELECT r.id
    FROM relationships r
    WHERE sqlc.arg(source_id) IN (r.source_id, r.target_id)
    ORDER BY r.embedding <=> sqlc.arg(embedding)
    LIMIT sqlc.arg(candidate_limit)
),
keyword_candidates AS (
    SELECT r.id
    FROM relationships r
    JOIN entities e ON e.id = CASE
        WHEN r.source_id = sqlc.arg(source_id) THEN r.target_id
        ELSE r.source_id
    END
    WHERE sqlc.arg(source_id) IN (r.source_id, r.target_id)
      AND COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0
      AND (e.search_tsv || r.search_tsv) @@ plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))
    ORDER BY ts_rank_cd((e.search_tsv || r.search_tsv), plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' '))) DESC,
             r.id
    LIMIT sqlc.arg(candidate_limit)
),
candidates AS (
    SELECT id FROM semantic_candidates
    UNION
    SELECT id FROM keyword_candidates
)
SELECT
    r.id as relationship_id,
    r.description as relationship_description,
    r.rank,
    r.source_id,
    r.target_id,
    e.id as neighbour_id,
    e.name as neighbour_name,
    e.type as neighbour_type,
    e.description as neighbour_description,
    (r.embedding <=> sqlc.arg(embedding))::double precision AS semantic_distance,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN
            ts_rank_cd((e.search_tsv || r.search_tsv), plainto_tsquery('simple', array_to_string(sqlc.arg(keywords)::text[], ' ')))
        ELSE 0
    END::double precision AS keyword_rank,
    CASE
        WHEN COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0) > 0 THEN (
            SELECT COUNT(*)::int
            FROM unnest(sqlc.arg(keywords)::text[]) AS kw
            WHERE kw <> ''
              AND position(lower(kw) in lower(e.name || ' ' || e.description || ' ' || r.description)) > 0
        )
        ELSE 0
    END::int AS keyword_matches,
    COALESCE(array_length(sqlc.arg(keywords)::text[], 1), 0)::int AS keyword_total
FROM candidates c
JOIN relationships r ON r.id = c.id
JOIN entities e
    ON e.id = CASE
        WHEN r.source_id = sqlc.arg(source_id) THEN r.target_id
        ELSE r.source_id
    END
WHERE sqlc.arg(source_id) IN (r.source_id, r.target_id)
ORDER BY semantic_distance ASC, r.id
LIMIT sqlc.arg(candidate_limit);
