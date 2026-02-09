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
INSERT INTO chat_messages (chat_id, role, content, tool_call_id, tool_name, tool_arguments, reasoning, metrics)
VALUES (
    sqlc.arg(chat_id)::bigint,
    sqlc.arg(role),
    sqlc.arg(content),
    sqlc.arg(tool_call_id),
    sqlc.arg(tool_name),
    sqlc.arg(tool_arguments),
    sqlc.arg(reasoning),
    sqlc.arg(metrics)
);

-- name: GetChatMessagesByChatID :many
SELECT * FROM chat_messages
WHERE chat_id = sqlc.arg(chat_id)::bigint
ORDER BY id ASC;

-- name: GetChatMessagesByChatIDWithoutToolCalls :many
SELECT * FROM chat_messages
WHERE chat_id = sqlc.arg(chat_id)::bigint
  AND role IN ('user', 'assistant')
ORDER BY id ASC;

-- name: GetUserChatsByProject :many
SELECT public_id, title FROM user_chats
WHERE user_id = sqlc.arg(user_id)
  AND project_id = sqlc.arg(project_id)::bigint
ORDER BY updated_at DESC, id DESC;

-- name: DeleteUserChatByPublicIDAndProject :execrows
DELETE FROM user_chats
WHERE public_id = sqlc.arg(public_id)
  AND user_id = sqlc.arg(user_id)
  AND project_id = sqlc.arg(project_id)::bigint;
