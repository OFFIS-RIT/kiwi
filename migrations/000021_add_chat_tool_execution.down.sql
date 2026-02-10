DROP INDEX IF EXISTS idx_chat_messages_chat_role_execution_id;

ALTER TABLE chat_messages
    DROP CONSTRAINT IF EXISTS chat_messages_tool_execution_check;

ALTER TABLE chat_messages
    DROP COLUMN IF EXISTS tool_execution;
