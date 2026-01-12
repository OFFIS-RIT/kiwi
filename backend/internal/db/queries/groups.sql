-- name: GetGroups :many
SELECT * FROM groups;

-- name: GetAllGroups :many
SELECT
    g.id AS group_id, 
    g.name AS group_name,
    'admin'::TEXT AS role
FROM groups g
ORDER BY g.id;

-- name: GetGroupsForUser :many
SELECT
    g.id AS group_id, 
    g.name AS group_name,
    gu.role AS role
FROM groups g
JOIN group_users gu
    ON gu.group_id = g.id
WHERE gu.user_id = $1;

-- name: IsUserInGroup :one
SELECT COUNT(*) AS count FROM group_users WHERE group_id = $1 AND user_id = $2;

-- name: GetGroup :one
SELECT * FROM groups WHERE id = $1;

-- name: GetGroupUsers :many
SELECT * FROM group_users WHERE group_id = $1;

-- name: CreateGroup :one
INSERT INTO groups (name)
VALUES ($1) RETURNING *;

-- name: UpdateGroup :one
UPDATE groups SET name = $2 WHERE id = $1 RETURNING *;

-- name: AddUserToGroup :one
INSERT INTO group_users (group_id, user_id, role)
VALUES ($1, $2, $3) RETURNING *;

-- name: DeleteGroup :exec
DELETE FROM groups WHERE id = $1;

-- name: DeleteUserFromGroup :exec
DELETE FROM group_users WHERE group_id = $1 AND user_id = $2;
