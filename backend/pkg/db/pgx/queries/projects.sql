-- name: GetAllProjectsWithGroups :many
SELECT
    grp.id AS group_id,
    grp.name AS group_name,
    g.id AS project_id,
    g.name AS project_name,
    g.state AS project_state,
    g.hidden,
    COALESCE(g.type, '') AS project_type,
    'admin'::TEXT AS role
FROM groups AS grp
JOIN graphs AS g ON g.group_id = grp.id
ORDER BY grp.id, g.id;

-- name: GetProjectsByGroup :many
SELECT DISTINCT g.*
FROM graphs AS g
LEFT JOIN graphs AS parent ON g.graph_id = parent.id
WHERE g.group_id = $1
   OR parent.group_id = $1;

-- name: GetProjectsForUser :many
SELECT
    grp.id AS group_id,
    grp.name AS group_name,
    g.id AS project_id,
    g.name AS project_name,
    g.state AS project_state,
    g.hidden,
    COALESCE(g.type, '') AS project_type,
    gu.role as role
FROM groups AS grp
JOIN graphs AS g
    ON g.group_id = grp.id
JOIN group_users AS gu
    ON gu.group_id = grp.id
WHERE gu.user_id = $1
  AND COALESCE(g.type, '') <> 'expert'
  AND g.hidden = FALSE
ORDER BY grp.id, g.id;

-- name: GetUserProjects :many
SELECT
    g.id AS project_id,
    g.name AS project_name,
    g.state AS project_state,
    g.hidden,
    COALESCE(g.type, '') AS project_type
FROM graphs AS g
WHERE g.user_id = $1
ORDER BY g.id;

-- name: IsUserInProject :one
SELECT
    COUNT(*) AS count
FROM graphs AS g
WHERE g.id = sqlc.arg(id)::bigint
  AND (
    g.user_id = sqlc.arg(user_id)::bigint
    OR (
      g.group_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM group_users AS gu
        WHERE gu.group_id = g.group_id
          AND gu.user_id = sqlc.arg(user_id)::bigint
      )
    )
    OR (
      g.graph_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM graphs AS parent
        WHERE parent.id = g.graph_id
          AND (
            parent.user_id = sqlc.arg(user_id)::bigint
            OR (
              parent.group_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM group_users AS parent_gu
                WHERE parent_gu.group_id = parent.group_id
                  AND parent_gu.user_id = sqlc.arg(user_id)::bigint
              )
            )
          )
      )
    )
    OR (g.user_id IS NULL AND g.group_id IS NULL AND g.graph_id IS NULL)
  );

-- name: GetProjectByID :one
SELECT * FROM graphs WHERE id = $1;

-- name: CreateProject :one
INSERT INTO graphs (group_id, name, state)
VALUES ($1, $2, $3) RETURNING *;

-- name: CreateProjectWithOwner :one
INSERT INTO graphs (group_id, user_id, graph_id, name, description, state, type, hidden)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: UpdateProject :one
UPDATE graphs SET name = $2 WHERE id = $1 RETURNING *;

-- name: UpdateProjectState :one
UPDATE graphs SET state = $2 WHERE id = $1 RETURNING *;

-- name: DeleteProject :exec
DELETE FROM graphs WHERE id = $1;

-- name: AddFileToProject :one
INSERT INTO project_files (project_id, name, file_key)
VALUES ($1, $2, $3) RETURNING *;

-- name: GetProjectFiles :many
SELECT * FROM project_files WHERE project_id = $1;

-- name: GetProjectFileByKey :one
SELECT *
FROM project_files
WHERE project_id = $1
  AND file_key = $2
  AND deleted = FALSE;

-- name: GetProjectIDsForFiles :many
SELECT DISTINCT project_id
FROM project_files
WHERE id = ANY(sqlc.arg(file_ids)::bigint[]);

-- name: DeleteProjectFile :exec
DELETE FROM project_files WHERE id = $1;

-- name: AddProjectUpdate :exec
INSERT INTO project_updates (project_id, update_type, update_message)
VALUES ($1, $2, $3);

-- name: GetDeletedProjectFiles :many
SELECT * FROM project_files WHERE project_id = $1 AND deleted = true;

-- name: MarkProjectFileAsDeleted :exec
UPDATE project_files 
SET deleted = true 
WHERE project_id = $1 AND file_key = $2;

-- name: GetProjectSystemPrompts :many
SELECT * FROM project_system_prompts WHERE project_id = $1;

-- name: AddTokenCountToFile :exec
UPDATE project_files SET token_count = $2 WHERE id = $1;

-- name: GetTokenCountsOfFiles :many
SELECT id, token_count
FROM project_files
WHERE id = ANY($1::bigint[]);

-- name: UpdateProjectFileMetadata :exec
UPDATE project_files SET metadata = $2, updated_at = NOW() WHERE id = $1;
