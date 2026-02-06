ALTER TABLE user_chats
    ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_user_chats_user_project_updated_at
    ON user_chats(user_id, project_id, updated_at DESC);

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS tool_call_id TEXT NOT NULL DEFAULT '';

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS tool_name TEXT NOT NULL DEFAULT '';

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS tool_arguments TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM chat_messages WHERE chat_id IS NULL) THEN
        RAISE EXCEPTION 'chat_messages.chat_id contains NULL values; aborting migration to avoid data loss';
    END IF;
END $$;

ALTER TABLE chat_messages
    ALTER COLUMN chat_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id_id
    ON chat_messages(chat_id, id);
