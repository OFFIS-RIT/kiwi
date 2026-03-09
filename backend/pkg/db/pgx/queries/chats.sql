-- name: CreateUserChat :one
INSERT INTO user_chats (id, user_id, project_id, title)
VALUES (
    sqlc.arg(id),
    sqlc.arg(user_id),
    sqlc.arg(project_id),
    sqlc.arg(title)
)
RETURNING *;

-- name: GetUserChatByIDAndProject :one
SELECT * FROM user_chats
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id)
  AND project_id = sqlc.arg(project_id);

-- name: TouchUserChat :exec
UPDATE user_chats
SET updated_at = NOW()
WHERE id = sqlc.arg(chat_id);

-- name: AddChatMessage :exec
INSERT INTO chat_messages (id, chat_id, role, content, tool_call_id, tool_name, tool_arguments, tool_execution, reasoning, metrics)
VALUES (
    sqlc.arg(id),
    sqlc.arg(chat_id),
    sqlc.arg(role),
    sqlc.arg(content),
    sqlc.arg(tool_call_id),
    sqlc.arg(tool_name),
    sqlc.arg(tool_arguments),
    sqlc.arg(tool_execution),
    sqlc.arg(reasoning),
    sqlc.arg(metrics)
);

-- name: GetChatMessagesByChatID :many
SELECT * FROM chat_messages
WHERE chat_id = sqlc.arg(chat_id)
ORDER BY created_at ASC, id ASC;

-- name: GetChatMessagesByChatIDWithoutServerToolCalls :many
SELECT * FROM chat_messages
WHERE chat_id = sqlc.arg(chat_id)
  AND (
      role IN ('user', 'assistant')
      OR role = 'assistant_tool_call'
      OR (role = 'tool' AND tool_execution = 'client')
  )
ORDER BY created_at ASC, id ASC;

-- name: GetUserChatsByProject :many
SELECT id, title FROM user_chats
WHERE user_id = sqlc.arg(user_id)
  AND project_id = sqlc.arg(project_id)
ORDER BY updated_at DESC, id DESC;

-- name: DeleteUserChatByIDAndProject :execrows
DELETE FROM user_chats
WHERE id = sqlc.arg(id)
  AND user_id = sqlc.arg(user_id)
  AND project_id = sqlc.arg(project_id);
