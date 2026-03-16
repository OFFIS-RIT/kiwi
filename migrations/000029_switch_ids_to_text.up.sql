-- Switch all identifier columns from BIGINT/BIGSERIAL to TEXT.
-- Existing rows without public IDs keep their numeric ID as a decimal string.
-- Graph/chat rows with public_id promote that value to the canonical id.

-- Drop indexes/constraints that depend on old bigint/public_id layouts.
DROP INDEX IF EXISTS idx_chat_messages_chat_id_id;
DROP INDEX IF EXISTS idx_chat_messages_chat_role_execution_id;
DROP INDEX IF EXISTS entity_sources_entity_id_id_idx;
DROP INDEX IF EXISTS relationship_sources_relationship_id_id_idx;
DROP INDEX IF EXISTS entity_sources_text_unit_id_idx;
DROP INDEX IF EXISTS relationship_sources_text_unit_id_idx;
DROP INDEX IF EXISTS relationships_project_source_target_idx;
DROP INDEX IF EXISTS relationships_project_source_id_idx;
DROP INDEX IF EXISTS relationships_project_target_id_idx;
DROP INDEX IF EXISTS relationship_source_idx;
DROP INDEX IF EXISTS relationship_target_idx;
DROP INDEX IF EXISTS entities_public_id_index;
DROP INDEX IF EXISTS relationships_public_id_index;

ALTER TABLE session DROP CONSTRAINT IF EXISTS "session_userId_fkey";
ALTER TABLE session DROP CONSTRAINT IF EXISTS "session_impersonatedBy_fkey";
ALTER TABLE account DROP CONSTRAINT IF EXISTS "account_userId_fkey";
ALTER TABLE group_users DROP CONSTRAINT IF EXISTS group_users_group_id_fkey;
ALTER TABLE group_users DROP CONSTRAINT IF EXISTS group_users_user_id_fkey;
ALTER TABLE graphs DROP CONSTRAINT IF EXISTS graphs_group_id_fkey;
ALTER TABLE graphs DROP CONSTRAINT IF EXISTS projects_group_id_fkey;
ALTER TABLE graphs DROP CONSTRAINT IF EXISTS graphs_user_id_fkey;
ALTER TABLE graphs DROP CONSTRAINT IF EXISTS graphs_graph_id_fkey;
ALTER TABLE project_system_prompts DROP CONSTRAINT IF EXISTS project_system_prompts_project_id_fkey;
ALTER TABLE project_updates DROP CONSTRAINT IF EXISTS project_updates_project_id_fkey;
ALTER TABLE project_files DROP CONSTRAINT IF EXISTS project_files_project_id_fkey;
ALTER TABLE text_units DROP CONSTRAINT IF EXISTS text_units_project_file_id_fkey;
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_project_id_fkey;
ALTER TABLE entity_sources DROP CONSTRAINT IF EXISTS entity_sources_entity_id_fkey;
ALTER TABLE entity_sources DROP CONSTRAINT IF EXISTS entity_sources_text_unit_id_fkey;
ALTER TABLE relationships DROP CONSTRAINT IF EXISTS relationships_source_id_fkey;
ALTER TABLE relationships DROP CONSTRAINT IF EXISTS relationships_target_id_fkey;
ALTER TABLE relationships DROP CONSTRAINT IF EXISTS relationships_project_id_fkey;
ALTER TABLE relationship_sources DROP CONSTRAINT IF EXISTS relationship_sources_relationship_id_fkey;
ALTER TABLE relationship_sources DROP CONSTRAINT IF EXISTS relationship_sources_text_unit_id_fkey;
ALTER TABLE user_chats DROP CONSTRAINT IF EXISTS user_chats_project_id_fkey;
ALTER TABLE user_chats DROP CONSTRAINT IF EXISTS user_chats_user_id_fkey;
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_chat_id_fkey;
ALTER TABLE workflow_stats DROP CONSTRAINT IF EXISTS workflow_stats_project_id_fkey;
ALTER TABLE workflow_stats DROP CONSTRAINT IF EXISTS workflow_stats_file_id_fkey;

DROP VIEW IF EXISTS stats_workflow_step_samples_v;

-- Direct bigint -> text conversions for IDs that keep the same value.
ALTER TABLE users ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE session ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE session ALTER COLUMN "userId" TYPE TEXT USING "userId"::text;
ALTER TABLE session ALTER COLUMN "impersonatedBy" TYPE TEXT USING CASE WHEN "impersonatedBy" IS NULL THEN NULL ELSE "impersonatedBy"::text END;
ALTER TABLE account ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE account ALTER COLUMN "userId" TYPE TEXT USING "userId"::text;
ALTER TABLE verification ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE groups ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE group_users ALTER COLUMN group_id TYPE TEXT USING group_id::text;
ALTER TABLE group_users ALTER COLUMN user_id TYPE TEXT USING user_id::text;
ALTER TABLE graphs ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE graphs ALTER COLUMN group_id TYPE TEXT USING CASE WHEN group_id IS NULL THEN NULL ELSE group_id::text END;
ALTER TABLE graphs ALTER COLUMN user_id TYPE TEXT USING CASE WHEN user_id IS NULL THEN NULL ELSE user_id::text END;
ALTER TABLE graphs ALTER COLUMN graph_id TYPE TEXT USING CASE WHEN graph_id IS NULL THEN NULL ELSE graph_id::text END;
ALTER TABLE project_system_prompts ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE project_system_prompts ALTER COLUMN project_id TYPE TEXT USING project_id::text;
ALTER TABLE project_updates ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE project_updates ALTER COLUMN project_id TYPE TEXT USING project_id::text;
ALTER TABLE project_files ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE project_files ALTER COLUMN project_id TYPE TEXT USING project_id::text;
ALTER TABLE chat_messages ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE workflow_step_attempts ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE stats ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE workflow_stats ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE workflow_stats ALTER COLUMN project_id TYPE TEXT USING project_id::text;
ALTER TABLE workflow_stats ALTER COLUMN file_id TYPE TEXT USING CASE WHEN file_id IS NULL THEN NULL ELSE file_id::text END;
ALTER TABLE workflow_stats ALTER COLUMN correlation_id TYPE TEXT USING correlation_id::text;

-- Promote public_id to canonical id for graph/chat tables.
ALTER TABLE text_units ADD COLUMN new_id TEXT, ADD COLUMN new_project_file_id TEXT;
UPDATE text_units SET new_id = public_id, new_project_file_id = project_file_id::text;

ALTER TABLE entities ADD COLUMN new_id TEXT, ADD COLUMN new_project_id TEXT;
UPDATE entities SET new_id = public_id, new_project_id = project_id::text;

ALTER TABLE entity_sources ADD COLUMN new_id TEXT, ADD COLUMN new_entity_id TEXT, ADD COLUMN new_text_unit_id TEXT;
UPDATE entity_sources es
SET new_id = es.public_id,
    new_entity_id = e.public_id,
    new_text_unit_id = tu.public_id
FROM entities e, text_units tu
WHERE es.entity_id = e.id
  AND es.text_unit_id = tu.id;

ALTER TABLE relationships ADD COLUMN new_id TEXT, ADD COLUMN new_source_id TEXT, ADD COLUMN new_target_id TEXT, ADD COLUMN new_project_id TEXT;
UPDATE relationships r
SET new_id = r.public_id,
    new_source_id = se.public_id,
    new_target_id = te.public_id,
    new_project_id = r.project_id::text
FROM entities se, entities te
WHERE r.source_id = se.id
  AND r.target_id = te.id;

ALTER TABLE relationship_sources ADD COLUMN new_id TEXT, ADD COLUMN new_relationship_id TEXT, ADD COLUMN new_text_unit_id TEXT;
UPDATE relationship_sources rs
SET new_id = rs.public_id,
    new_relationship_id = r.public_id,
    new_text_unit_id = tu.public_id
FROM relationships r, text_units tu
WHERE rs.relationship_id = r.id
  AND rs.text_unit_id = tu.id;

ALTER TABLE user_chats ADD COLUMN new_id TEXT, ADD COLUMN new_user_id TEXT, ADD COLUMN new_project_id TEXT;
UPDATE user_chats
SET new_id = public_id,
    new_user_id = user_id::text,
    new_project_id = CASE WHEN project_id IS NULL THEN NULL ELSE project_id::text END;

ALTER TABLE chat_messages ADD COLUMN new_chat_id TEXT;
UPDATE chat_messages cm
SET new_chat_id = uc.public_id
FROM user_chats uc
WHERE cm.chat_id = uc.id;

-- Replace old id/public_id columns.
ALTER TABLE text_units DROP CONSTRAINT IF EXISTS text_units_pkey;
ALTER TABLE text_units DROP CONSTRAINT IF EXISTS text_units_public_id_key;
ALTER TABLE text_units DROP COLUMN id;
ALTER TABLE text_units DROP COLUMN public_id;
ALTER TABLE text_units DROP COLUMN project_file_id;
ALTER TABLE text_units RENAME COLUMN new_id TO id;
ALTER TABLE text_units RENAME COLUMN new_project_file_id TO project_file_id;
ALTER TABLE text_units ADD PRIMARY KEY (id);

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_pkey;
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_public_id_key;
ALTER TABLE entities DROP COLUMN id;
ALTER TABLE entities DROP COLUMN public_id;
ALTER TABLE entities DROP COLUMN project_id;
ALTER TABLE entities RENAME COLUMN new_id TO id;
ALTER TABLE entities RENAME COLUMN new_project_id TO project_id;
ALTER TABLE entities ADD PRIMARY KEY (id);

ALTER TABLE entity_sources DROP CONSTRAINT IF EXISTS entity_sources_pkey;
ALTER TABLE entity_sources DROP CONSTRAINT IF EXISTS entity_sources_public_id_key;
ALTER TABLE entity_sources DROP COLUMN id;
ALTER TABLE entity_sources DROP COLUMN public_id;
ALTER TABLE entity_sources DROP COLUMN entity_id;
ALTER TABLE entity_sources DROP COLUMN text_unit_id;
ALTER TABLE entity_sources RENAME COLUMN new_id TO id;
ALTER TABLE entity_sources RENAME COLUMN new_entity_id TO entity_id;
ALTER TABLE entity_sources RENAME COLUMN new_text_unit_id TO text_unit_id;
ALTER TABLE entity_sources ADD PRIMARY KEY (id);

ALTER TABLE relationships DROP CONSTRAINT IF EXISTS relationships_pkey;
ALTER TABLE relationships DROP CONSTRAINT IF EXISTS relationships_public_id_key;
ALTER TABLE relationships DROP COLUMN id;
ALTER TABLE relationships DROP COLUMN public_id;
ALTER TABLE relationships DROP COLUMN source_id;
ALTER TABLE relationships DROP COLUMN target_id;
ALTER TABLE relationships DROP COLUMN project_id;
ALTER TABLE relationships RENAME COLUMN new_id TO id;
ALTER TABLE relationships RENAME COLUMN new_source_id TO source_id;
ALTER TABLE relationships RENAME COLUMN new_target_id TO target_id;
ALTER TABLE relationships RENAME COLUMN new_project_id TO project_id;
ALTER TABLE relationships ADD PRIMARY KEY (id);

ALTER TABLE relationship_sources DROP CONSTRAINT IF EXISTS relationship_sources_pkey;
ALTER TABLE relationship_sources DROP CONSTRAINT IF EXISTS relationship_sources_public_id_key;
ALTER TABLE relationship_sources DROP COLUMN id;
ALTER TABLE relationship_sources DROP COLUMN public_id;
ALTER TABLE relationship_sources DROP COLUMN relationship_id;
ALTER TABLE relationship_sources DROP COLUMN text_unit_id;
ALTER TABLE relationship_sources RENAME COLUMN new_id TO id;
ALTER TABLE relationship_sources RENAME COLUMN new_relationship_id TO relationship_id;
ALTER TABLE relationship_sources RENAME COLUMN new_text_unit_id TO text_unit_id;
ALTER TABLE relationship_sources ADD PRIMARY KEY (id);

ALTER TABLE user_chats DROP CONSTRAINT IF EXISTS user_chats_pkey;
ALTER TABLE user_chats DROP CONSTRAINT IF EXISTS user_chats_public_id_key;
ALTER TABLE user_chats DROP COLUMN id;
ALTER TABLE user_chats DROP COLUMN public_id;
ALTER TABLE user_chats DROP COLUMN user_id;
ALTER TABLE user_chats DROP COLUMN project_id;
ALTER TABLE user_chats RENAME COLUMN new_id TO id;
ALTER TABLE user_chats RENAME COLUMN new_user_id TO user_id;
ALTER TABLE user_chats RENAME COLUMN new_project_id TO project_id;
ALTER TABLE user_chats ADD PRIMARY KEY (id);

ALTER TABLE chat_messages DROP COLUMN chat_id;
ALTER TABLE chat_messages RENAME COLUMN new_chat_id TO chat_id;

-- Restore constraints with final text-based references.
ALTER TABLE session ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE session ADD CONSTRAINT "session_impersonatedBy_fkey" FOREIGN KEY ("impersonatedBy") REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE account ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE group_users ADD CONSTRAINT group_users_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE group_users ADD CONSTRAINT group_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE graphs ADD CONSTRAINT graphs_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE graphs ADD CONSTRAINT graphs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE graphs ADD CONSTRAINT graphs_graph_id_fkey FOREIGN KEY (graph_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE project_system_prompts ADD CONSTRAINT project_system_prompts_project_id_fkey FOREIGN KEY (project_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE project_updates ADD CONSTRAINT project_updates_project_id_fkey FOREIGN KEY (project_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE project_files ADD CONSTRAINT project_files_project_id_fkey FOREIGN KEY (project_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE text_units ADD CONSTRAINT text_units_project_file_id_fkey FOREIGN KEY (project_file_id) REFERENCES project_files(id) ON DELETE CASCADE;
ALTER TABLE entities ADD CONSTRAINT entities_project_id_fkey FOREIGN KEY (project_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE entity_sources ADD CONSTRAINT entity_sources_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE;
ALTER TABLE entity_sources ADD CONSTRAINT entity_sources_text_unit_id_fkey FOREIGN KEY (text_unit_id) REFERENCES text_units(id) ON DELETE CASCADE;
ALTER TABLE relationships ADD CONSTRAINT relationships_source_id_fkey FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE;
ALTER TABLE relationships ADD CONSTRAINT relationships_target_id_fkey FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE;
ALTER TABLE relationships ADD CONSTRAINT relationships_project_id_fkey FOREIGN KEY (project_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE relationship_sources ADD CONSTRAINT relationship_sources_relationship_id_fkey FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE CASCADE;
ALTER TABLE relationship_sources ADD CONSTRAINT relationship_sources_text_unit_id_fkey FOREIGN KEY (text_unit_id) REFERENCES text_units(id) ON DELETE CASCADE;
ALTER TABLE user_chats ADD CONSTRAINT user_chats_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_chats ADD CONSTRAINT user_chats_project_id_fkey FOREIGN KEY (project_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES user_chats(id) ON DELETE CASCADE;
ALTER TABLE workflow_stats ADD CONSTRAINT workflow_stats_project_id_fkey FOREIGN KEY (project_id) REFERENCES graphs(id) ON DELETE CASCADE;
ALTER TABLE workflow_stats ADD CONSTRAINT workflow_stats_file_id_fkey FOREIGN KEY (file_id) REFERENCES project_files(id) ON DELETE SET NULL;

ALTER TABLE text_units ALTER COLUMN id SET NOT NULL;
ALTER TABLE text_units ALTER COLUMN project_file_id SET NOT NULL;
ALTER TABLE entities ALTER COLUMN id SET NOT NULL;
ALTER TABLE entities ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE entity_sources ALTER COLUMN id SET NOT NULL;
ALTER TABLE entity_sources ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE entity_sources ALTER COLUMN text_unit_id SET NOT NULL;
ALTER TABLE relationships ALTER COLUMN id SET NOT NULL;
ALTER TABLE relationships ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE relationships ALTER COLUMN target_id SET NOT NULL;
ALTER TABLE relationships ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE relationship_sources ALTER COLUMN id SET NOT NULL;
ALTER TABLE relationship_sources ALTER COLUMN relationship_id SET NOT NULL;
ALTER TABLE relationship_sources ALTER COLUMN text_unit_id SET NOT NULL;
ALTER TABLE user_chats ALTER COLUMN id SET NOT NULL;
ALTER TABLE user_chats ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE chat_messages ALTER COLUMN chat_id SET NOT NULL;

ALTER TABLE users ALTER COLUMN id DROP DEFAULT;
ALTER TABLE session ALTER COLUMN id DROP DEFAULT;
ALTER TABLE account ALTER COLUMN id DROP DEFAULT;
ALTER TABLE verification ALTER COLUMN id DROP DEFAULT;
ALTER TABLE groups ALTER COLUMN id DROP DEFAULT;
ALTER TABLE graphs ALTER COLUMN id DROP DEFAULT;
ALTER TABLE project_system_prompts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE project_updates ALTER COLUMN id DROP DEFAULT;
ALTER TABLE project_files ALTER COLUMN id DROP DEFAULT;
ALTER TABLE chat_messages ALTER COLUMN id DROP DEFAULT;
ALTER TABLE workflow_step_attempts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE stats ALTER COLUMN id DROP DEFAULT;
ALTER TABLE workflow_stats ALTER COLUMN id DROP DEFAULT;

-- Final indexes matching the text-ID schema.
CREATE INDEX IF NOT EXISTS relationship_source_idx ON relationships (project_id, source_id);
CREATE INDEX IF NOT EXISTS relationship_target_idx ON relationships (project_id, target_id);
CREATE INDEX IF NOT EXISTS entities_project_type_idx ON entities(project_id, type);
CREATE INDEX IF NOT EXISTS entities_project_name_idx ON entities(project_id, name);
CREATE INDEX IF NOT EXISTS entities_name_trgm_idx ON entities USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS relationships_project_source_target_idx ON relationships(project_id, source_id, target_id);
CREATE INDEX IF NOT EXISTS text_units_project_file_id_idx ON text_units(project_file_id);
CREATE INDEX IF NOT EXISTS entity_sources_entity_id_id_idx ON entity_sources(entity_id, id);
CREATE INDEX IF NOT EXISTS entity_sources_text_unit_id_idx ON entity_sources(text_unit_id);
CREATE INDEX IF NOT EXISTS relationship_sources_relationship_id_id_idx ON relationship_sources(relationship_id, id);
CREATE INDEX IF NOT EXISTS relationship_sources_text_unit_id_idx ON relationship_sources(text_unit_id);
CREATE INDEX IF NOT EXISTS idx_user_chats_user_project_updated_at ON user_chats(user_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id_id ON chat_messages(chat_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_role_execution_id ON chat_messages(chat_id, role, tool_execution, created_at, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id_user_assistant ON chat_messages(chat_id, id) WHERE role IN ('user', 'assistant');

DROP SEQUENCE IF EXISTS users_id_seq;
DROP SEQUENCE IF EXISTS session_id_seq;
DROP SEQUENCE IF EXISTS account_id_seq;
DROP SEQUENCE IF EXISTS verification_id_seq;
DROP SEQUENCE IF EXISTS groups_id_seq;
DROP SEQUENCE IF EXISTS projects_id_seq;
DROP SEQUENCE IF EXISTS project_system_prompts_id_seq;
DROP SEQUENCE IF EXISTS project_updates_id_seq;
DROP SEQUENCE IF EXISTS project_files_id_seq;
DROP SEQUENCE IF EXISTS text_units_id_seq;
DROP SEQUENCE IF EXISTS entities_id_seq;
DROP SEQUENCE IF EXISTS entity_sources_id_seq;
DROP SEQUENCE IF EXISTS relationships_id_seq;
DROP SEQUENCE IF EXISTS relationship_sources_id_seq;
DROP SEQUENCE IF EXISTS user_chats_id_seq;
DROP SEQUENCE IF EXISTS chat_messages_id_seq;
DROP SEQUENCE IF EXISTS workflow_step_attempts_id_seq;
DROP SEQUENCE IF EXISTS stats_id_seq;
DROP SEQUENCE IF EXISTS workflow_stats_id_seq;

CREATE VIEW stats_workflow_step_samples_v AS
SELECT
    s.id,
    s.type,
    s.run_id,
    s.created_at,
    COALESCE(s.data->>'workflow_name', '') AS workflow_name,
    COALESCE(s.data->>'workflow_version', '') AS workflow_version,
    COALESCE(s.data->>'operation', '') AS operation,
    COALESCE(s.data->'ai'->>'adapter', '') AS ai_adapter,
    COALESCE(s.data->'ai'->>'chat_model', '') AS chat_model,
    COALESCE(s.data->'ai'->>'embed_model', '') AS embed_model,
    COALESCE(s.data->'features'->>'file_type', '') AS file_type,
    COALESCE((s.data->'features'->>'needs_ocr')::boolean, FALSE) AS needs_ocr,
    COALESCE((s.data->'features'->>'estimated_tokens')::bigint, 0) AS estimated_tokens,
    COALESCE((s.data->'features'->>'chunk_count')::int, 0) AS chunk_count,
    COALESCE((s.data->'features'->>'entity_count')::int, 0) AS entity_count,
    COALESCE((s.data->'features'->>'relationship_count')::int, 0) AS relationship_count,
    COALESCE((s.data->'features'->>'source_count')::int, 0) AS source_count,
    COALESCE((s.data->>'duration_ms')::bigint, 0) AS duration_ms,
    regexp_replace(s.type, '^.*\.', '') AS step_name,
    COALESCE(((s.data->'features'->>'estimated_tokens')::bigint / 512)::int, 0) AS token_bucket,
    COALESCE(((s.data->'features'->>'chunk_count')::int / 5), 0) AS chunk_bucket,
    COALESCE(((s.data->'features'->>'source_count')::int / 5), 0) AS source_bucket
FROM stats s
WHERE s.type LIKE 'workflow.%';
