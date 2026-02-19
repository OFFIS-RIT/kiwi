-- name: GetExpertProjectByProjectID :one
SELECT
    g.id AS project_id,
    g.group_id,
    g.user_id,
    g.graph_id,
    g.name,
    g.description,
    g.state,
    COALESCE(g.type, '') AS project_type,
    g.hidden,
    g.created_at,
    g.updated_at
FROM graphs AS g
WHERE g.type = 'expert'
  AND g.id = $1;

-- name: GetExpertProjects :many
SELECT
    g.id AS project_id,
    g.group_id,
    g.user_id,
    g.graph_id,
    g.name,
    g.description,
    g.state,
    COALESCE(g.type, '') AS project_type,
    g.hidden,
    g.created_at,
    g.updated_at
FROM graphs AS g
WHERE g.type = 'expert'
ORDER BY g.id ASC;

-- name: GetAvailableExpertProjects :many
WITH current_graph AS (
    SELECT
        g.id,
        COALESCE(g.group_id, parent.group_id) AS group_id
    FROM graphs AS g
    LEFT JOIN graphs AS parent ON g.graph_id = parent.id
    WHERE g.id = sqlc.arg(current_project_id)::bigint
)
SELECT
    p.id AS project_id,
    p.group_id,
    p.user_id,
    p.graph_id,
    p.name,
    p.description,
    p.state,
    p.hidden,
    p.created_at,
    p.updated_at
FROM graphs AS p
LEFT JOIN graphs AS parent ON p.graph_id = parent.id
LEFT JOIN current_graph AS cg ON TRUE
WHERE p.type = 'expert'
  AND p.state = 'ready'
  AND (
      (cg.group_id IS NOT NULL AND COALESCE(p.group_id, parent.group_id) = cg.group_id)
      OR (p.group_id IS NULL AND p.user_id IS NULL AND p.graph_id IS NULL)
      OR p.user_id = sqlc.arg(user_id)::bigint
      OR p.graph_id = sqlc.arg(current_project_id)::bigint
  )
ORDER BY p.id ASC;
