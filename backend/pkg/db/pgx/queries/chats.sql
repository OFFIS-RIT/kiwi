-- name: CreateUserChat :one
INSERT INTO user_chats (public_id, user_id, project_id, title)
VALUES (
    sqlc.arg(public_id),
    sqlc.arg(user_id),
    sqlc.arg(project_id)::bigint,
    sqlc.arg(title)
)
RETURNING *;

-- name: GetUserChatByPublicIDAndProject :one
SELECT * FROM user_chats
WHERE public_id = sqlc.arg(public_id)
  AND user_id = sqlc.arg(user_id)
  AND project_id = sqlc.arg(project_id)::bigint;

-- name: TouchUserChat :exec
UPDATE user_chats
SET updated_at = NOW()
WHERE id = sqlc.arg(chat_id)::bigint;

-- name: AddChatMessage :exec
INSERT INTO chat_messages (chat_id, role, content, tool_call_id, tool_name, tool_arguments)
VALUES (
    sqlc.arg(chat_id)::bigint,
    sqlc.arg(role),
    sqlc.arg(content),
    sqlc.arg(tool_call_id),
    sqlc.arg(tool_name),
    sqlc.arg(tool_arguments)
);

-- name: GetChatMessagesByChatID :many
SELECT * FROM chat_messages
WHERE chat_id = sqlc.arg(chat_id)::bigint
ORDER BY id ASC;
