ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS reasoning TEXT;

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS metrics JSONB;
