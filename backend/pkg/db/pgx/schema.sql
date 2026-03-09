-- Users Table
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
    image TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "role" TEXT,
    "banned" BOOLEAN,
    "banReason" TEXT,
    "banExpires" TIMESTAMPTZ
);

-- Session table
CREATE TABLE session (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "impersonatedBy" TEXT REFERENCES "users"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX session_token_idx ON session(token);

-- Account table
CREATE TABLE account (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    scope TEXT,
    "idToken" TEXT,
    password TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Verification table
CREATE TABLE verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- JWKS table
CREATE TABLE jwks (
    id TEXT PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt" TIMESTAMPTZ
);

-- Groups Table
CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

-- Group Users Table
CREATE TABLE group_users (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- Graphs Table
CREATE TABLE graphs (
    id TEXT PRIMARY KEY,
    group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    graph_id TEXT REFERENCES graphs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    state TEXT NOT NULL DEFAULT 'ready',
    type TEXT,
    hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT graphs_single_owner_check CHECK (
        ((group_id IS NOT NULL)::INT + (user_id IS NOT NULL)::INT + (graph_id IS NOT NULL)::INT) <= 1
    )
);

CREATE INDEX IF NOT EXISTS graphs_group_type_idx
    ON graphs (group_id, type);

CREATE INDEX IF NOT EXISTS graphs_user_type_idx
    ON graphs (user_id, type);

CREATE INDEX IF NOT EXISTS graphs_graph_type_idx
    ON graphs (graph_id, type);

-- Project Prompts
CREATE TABLE project_system_prompts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project updates Table
CREATE TABLE project_updates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    update_type TEXT NOT NULL,
    update_message JSON NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project Files Table
CREATE TABLE project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    file_key TEXT NOT NULL,
    deleted boolean DEFAULT false,
    token_count INT NOT NULL DEFAULT 0,
    metadata TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Text Units Table
CREATE TABLE text_units (
    id TEXT PRIMARY KEY,
    project_file_id TEXT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Entities Table
CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(description, '')), 'B')
    ) STORED,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Entity Sources Table
CREATE TABLE entity_sources (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    text_unit_id TEXT NOT NULL REFERENCES text_units(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(description, '')), 'A')
    ) STORED,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Relationships Table
CREATE TABLE relationships (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    rank FLOAT NOT NULL DEFAULT 0,
    description TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(description, '')), 'A')
    ) STORED,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Relationship Sources Table
CREATE TABLE relationship_sources (
    id TEXT PRIMARY KEY,
    relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
    text_unit_id TEXT NOT NULL REFERENCES text_units(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(description, '')), 'A')
    ) STORED,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User Chats Table
CREATE TABLE IF NOT EXISTS user_chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES graphs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES user_chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_call_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    tool_arguments TEXT NOT NULL DEFAULT '',
    tool_execution TEXT NOT NULL DEFAULT '' CHECK (tool_execution IN ('', 'server', 'client')),
    reasoning TEXT,
    metrics JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_chats_user_project_updated_at
    ON user_chats(user_id, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id_id
    ON chat_messages(chat_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_role_execution_id
    ON chat_messages(chat_id, role, tool_execution, created_at, id);

CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    input JSONB NOT NULL,
    output JSONB NOT NULL DEFAULT 'null'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
    error_message TEXT NOT NULL DEFAULT '',
    attempt_count INT NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    worker_id TEXT NOT NULL DEFAULT '',
    lease_token TEXT NOT NULL DEFAULT '',
    wait_reason TEXT NOT NULL DEFAULT '',
    sleep_until TIMESTAMPTZ,
    idempotency_key TEXT,
    parent_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    parent_step_name TEXT,
    root_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    retry_initial_interval_ms BIGINT NOT NULL DEFAULT 1000,
    retry_backoff_coefficient DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    retry_maximum_interval_ms BIGINT NOT NULL DEFAULT 30000,
    retry_maximum_attempts INT NOT NULL DEFAULT 3,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name, version, idempotency_key)
);

CREATE TABLE workflow_step_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_attempt INT NOT NULL DEFAULT 1,
    step_name TEXT NOT NULL,
    step_index INT NOT NULL,
    step_type TEXT NOT NULL DEFAULT 'run' CHECK (step_type IN ('run', 'sleep', 'workflow')),
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
    input JSONB NOT NULL DEFAULT 'null'::jsonb,
    output JSONB NOT NULL DEFAULT 'null'::jsonb,
    error_message TEXT NOT NULL DEFAULT '',
    attempt_number INT NOT NULL DEFAULT 1,
    next_attempt_at TIMESTAMPTZ,
    sleep_until TIMESTAMPTZ,
    child_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_workflow_runs_status_available
    ON workflow_runs(status, available_at, created_at)
    WHERE status IN ('pending', 'running');

CREATE INDEX idx_workflow_runs_parent
    ON workflow_runs(parent_run_id);

CREATE INDEX idx_workflow_runs_root
    ON workflow_runs(root_run_id);

CREATE INDEX idx_workflow_step_attempts_run
    ON workflow_step_attempts(run_id, created_at, id);

CREATE INDEX idx_workflow_step_attempts_child
    ON workflow_step_attempts(child_run_id)
    WHERE child_run_id IS NOT NULL;

CREATE UNIQUE INDEX idx_workflow_step_attempts_completed
    ON workflow_step_attempts(run_id, step_name)
    WHERE status = 'completed';

-- Generic workflow statistics samples.
CREATE TABLE IF NOT EXISTS stats (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Live workflow progress projection for workflow-specific tracking.
CREATE TABLE workflow_stats (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    correlation_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    workflow_version TEXT NOT NULL DEFAULT '',
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    file_id TEXT REFERENCES project_files(id) ON DELETE SET NULL,
    operation TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    current_step TEXT NOT NULL DEFAULT '',
    current_step_started_at TIMESTAMPTZ,
    estimated_duration BIGINT NOT NULL DEFAULT 0,
    prediction_sample_count INT NOT NULL DEFAULT 0,
    prediction_fallback_level INT NOT NULL DEFAULT 0,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    prediction JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (correlation_id, subject_type, subject_id)
);

CREATE UNIQUE INDEX idx_workflow_stats_run_id
    ON workflow_stats (run_id)
    WHERE run_id IS NOT NULL;

CREATE INDEX idx_workflow_stats_project_created
    ON workflow_stats (project_id, created_at DESC);

CREATE INDEX idx_workflow_stats_project_correlation
    ON workflow_stats (project_id, correlation_id);

CREATE INDEX idx_workflow_stats_file_latest
    ON workflow_stats (project_id, file_id, created_at DESC)
    WHERE file_id IS NOT NULL;

CREATE INDEX idx_workflow_stats_correlation_status
    ON workflow_stats (correlation_id, subject_type, status);

CREATE INDEX idx_workflow_stats_correlation_step_started
    ON workflow_stats (correlation_id, current_step_started_at);

CREATE INDEX idx_stats_type_created
    ON stats (type, created_at DESC);

CREATE INDEX idx_stats_workflow_lookup
    ON stats (
        type,
        (data->>'workflow_name'),
        (data->>'workflow_version'),
        (data->>'operation'),
        ((data->'features'->>'file_type')),
        ((data->'ai'->>'adapter')),
        ((data->'ai'->>'chat_model')),
        ((((data->'features'->>'estimated_tokens')::bigint) / 512)),
        ((((data->'features'->>'chunk_count')::int) / 5)),
        created_at DESC
    )
    WHERE type LIKE 'workflow.%';

CREATE INDEX idx_stats_description_lookup
    ON stats (
        type,
        (data->>'workflow_version'),
        ((data->'ai'->>'adapter')),
        ((data->'ai'->>'chat_model')),
        ((((data->'features'->>'source_count')::int) / 5)),
        created_at DESC
    )
    WHERE type = 'workflow.description.describe';

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
