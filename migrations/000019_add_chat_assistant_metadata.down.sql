ALTER TABLE chat_messages
    DROP COLUMN IF EXISTS metrics;

ALTER TABLE chat_messages
    DROP COLUMN IF EXISTS reasoning;
