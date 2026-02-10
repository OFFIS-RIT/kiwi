ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS tool_execution TEXT NOT NULL DEFAULT '';

ALTER TABLE chat_messages
    DROP CONSTRAINT IF EXISTS chat_messages_tool_execution_check;

ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_tool_execution_check
        CHECK (tool_execution IN ('', 'server', 'client'));

-- Backfill assistant tool calls: known graph tools are server-executed.
-- Unknown tool names are treated as client-executed to avoid hiding
-- historical client tools from chat history after this migration.
UPDATE chat_messages
SET tool_execution = CASE
    WHEN tool_name = ANY (ARRAY[
        'search_entities',
        'search_relationships',
        'get_entity_neighbours',
        'get_entity_neighbors',
        'path_between_entities',
        'get_entity_sources',
        'get_relationship_sources',
        'get_entity_details',
        'get_relationship_details',
        'get_entity_types',
        'search_entities_by_type',
        'get_source_document_metadata'
    ]) THEN 'server'
    ELSE 'client'
END
WHERE role = 'assistant_tool_call'
  AND tool_execution = '';

-- Backfill tool results by inheriting execution from their related tool call.
-- Fall back to name-based classification when no matching call is found.
UPDATE chat_messages AS tool_msg
SET tool_execution = COALESCE(
    (
        SELECT call_msg.tool_execution
        FROM chat_messages AS call_msg
        WHERE call_msg.chat_id = tool_msg.chat_id
          AND call_msg.role = 'assistant_tool_call'
          AND call_msg.tool_call_id = tool_msg.tool_call_id
          AND call_msg.tool_call_id <> ''
        ORDER BY call_msg.id DESC
        LIMIT 1
    ),
    CASE
        WHEN tool_msg.tool_name = ANY (ARRAY[
            'search_entities',
            'search_relationships',
            'get_entity_neighbours',
            'get_entity_neighbors',
            'path_between_entities',
            'get_entity_sources',
            'get_relationship_sources',
            'get_entity_details',
            'get_relationship_details',
            'get_entity_types',
            'search_entities_by_type',
            'get_source_document_metadata'
        ]) THEN 'server'
        WHEN tool_msg.tool_name <> '' THEN 'client'
        ELSE 'server'
    END
)
WHERE tool_msg.role = 'tool'
  AND tool_msg.tool_execution = '';

UPDATE chat_messages
SET tool_execution = ''
WHERE role IN ('user', 'assistant')
  AND tool_execution = '';

-- Safety fallback for unexpected legacy rows.
UPDATE chat_messages
SET tool_execution = 'server'
WHERE role IN ('assistant_tool_call', 'tool')
  AND tool_execution = '';

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_role_execution_id
    ON chat_messages(chat_id, role, tool_execution, id);
