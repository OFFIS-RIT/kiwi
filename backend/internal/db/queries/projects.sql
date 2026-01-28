-- name: GetProjects :many
SELECT * FROM projects;

-- name: GetAllProjectsWithGroups :many
SELECT
    g.id   AS group_id,
    g.name AS group_name,
    p.id   AS project_id,
    p.name AS project_name,
    p.state AS project_state,
    'admin'::TEXT AS role
FROM groups AS g
JOIN projects AS p ON p.group_id = g.id
ORDER BY g.id, p.id;

-- name: GetProjectsByGroup :many
SELECT * FROM projects WHERE group_id = $1;

-- name: GetProjectsForUser :many
SELECT
    g.id   AS group_id,
    g.name AS group_name,
    p.id   AS project_id,
    p.name AS project_name,
    p.state AS project_state,
    gu.role as role
FROM groups AS g
JOIN projects AS p
    ON p.group_id = g.id
JOIN group_users AS gu
    ON gu.group_id = g.id
WHERE gu.user_id = $1
ORDER BY g.id, p.id;

-- name: IsUserInProject :one
SELECT
    COUNT(*) AS count
FROM projects AS p
JOIN groups AS g
    ON g.id = p.group_id
JOIN group_users AS gu
    ON gu.group_id = g.id
WHERE gu.user_id = $1 AND p.id = $2;

-- name: CreateProject :one
INSERT INTO projects (group_id, name, state)
VALUES ($1, $2, $3) RETURNING *;

-- name: UpdateProject :one
UPDATE projects SET name = $2 WHERE id = $1 RETURNING *;

-- name: UpdateProjectState :one
UPDATE projects SET state = $2 WHERE id = $1 RETURNING *;

-- name: DeleteProject :exec
DELETE FROM projects WHERE id = $1;

-- name: AddFileToProject :one
INSERT INTO project_files (project_id, name, file_key)
VALUES ($1, $2, $3) RETURNING *;

-- name: GetProjectFiles :many
SELECT * FROM project_files WHERE project_id = $1;

-- name: GetProjectIDsForFiles :many
SELECT DISTINCT project_id
FROM project_files
WHERE id = ANY(sqlc.arg(file_ids)::bigint[]);

-- name: DeleteFileFromProject :exec
DELETE FROM project_files
WHERE project_id = $1 AND file_key = $2;

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

-- name: GetActiveProjectFiles :many
SELECT * FROM project_files 
WHERE project_id = $1 AND (deleted = false OR deleted IS NULL);

-- name: GetProjectSystemPrompts :many
SELECT * FROM project_system_prompts WHERE project_id = $1;

-- name: AddTokenCountToFile :exec
UPDATE project_files SET token_count = $2 WHERE id = $1;

-- name: GetTokenCountOfFile :one
SELECT token_count FROM project_files WHERE id = $1;

-- name: UpdateProjectFileMetadata :exec
UPDATE project_files SET metadata = $2, updated_at = NOW() WHERE id = $1;

-- name: AcquireProjectLock :exec
SELECT pg_advisory_lock($1::bigint);

-- name: ReleaseProjectLock :exec
SELECT pg_advisory_unlock($1::bigint);

-- name: TryAcquireProjectLock :one
SELECT pg_try_advisory_lock($1::bigint) as acquired;

-- name: AcquireProjectXactLock :exec
SELECT pg_advisory_xact_lock($1::bigint);

-- name: TryAcquireProjectXactLock :one
SELECT pg_try_advisory_xact_lock($1::bigint) as acquired;
