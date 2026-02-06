DROP INDEX IF EXISTS idx_chat_messages_chat_id_id;

ALTER TABLE chat_messages
    ALTER COLUMN chat_id DROP NOT NULL;

ALTER TABLE chat_messages
    DROP COLUMN IF EXISTS tool_arguments;

ALTER TABLE chat_messages
    DROP COLUMN IF EXISTS tool_name;

ALTER TABLE chat_messages
    DROP COLUMN IF EXISTS tool_call_id;

DROP INDEX IF EXISTS idx_user_chats_user_project_updated_at;

ALTER TABLE user_chats
    DROP COLUMN IF EXISTS project_id;
