-- Users Table
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
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
    id BIGSERIAL PRIMARY KEY,
    "userId" BIGINT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "impersonatedBy" BIGINT REFERENCES "users"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX session_token_idx ON session(token);

-- Account table
CREATE TABLE account (
    id BIGSERIAL PRIMARY KEY,
    "userId" BIGINT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
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
    id BIGSERIAL PRIMARY KEY,
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
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL
);

-- Group Users Table
CREATE TABLE group_users (
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- Graphs Table
CREATE TABLE graphs (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    graph_id BIGINT REFERENCES graphs(id) ON DELETE CASCADE,
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
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project updates Table
CREATE TABLE project_updates (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    update_type TEXT NOT NULL,
    update_message JSON NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project Files Table
CREATE TABLE project_files (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
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
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    project_file_id BIGINT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Entities Table
CREATE TABLE entities (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
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
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL,
    entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    text_unit_id BIGINT NOT NULL REFERENCES text_units(id) ON DELETE CASCADE,
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
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL,
    source_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
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
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL,
    relationship_id BIGINT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
    text_unit_id BIGINT NOT NULL REFERENCES text_units(id) ON DELETE CASCADE,
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
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT UNIQUE NOT NULL,
    user_id BIGINT NOT NULL,
    project_id BIGINT REFERENCES graphs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES user_chats(id) ON DELETE CASCADE,
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
    ON chat_messages(chat_id, id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_role_execution_id
    ON chat_messages(chat_id, role, tool_execution, id);

-- Stats Table
CREATE TABLE IF NOT EXISTS stats (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    amount INT NOT NULL DEFAULT 0,
    duration BIGINT NOT NULL DEFAULT 0,
    stat_type TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Batch tracking table for parallel worker processing
CREATE TABLE project_batch_status (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    correlation_id VARCHAR(21) NOT NULL,
    batch_id INT NOT NULL,
    total_batches INT NOT NULL,
    files_count INT NOT NULL DEFAULT 0,
    file_ids BIGINT[] DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    operation VARCHAR(10) NOT NULL DEFAULT 'index',
    estimated_duration BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    UNIQUE(correlation_id, batch_id)
);

-- Track parallel description generation jobs per correlation.
CREATE TABLE project_description_job_status (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    correlation_id VARCHAR(21) NOT NULL,
    job_id INT NOT NULL,
    total_jobs INT NOT NULL,
    entity_ids BIGINT[] DEFAULT '{}',
    relationship_ids BIGINT[] DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    UNIQUE(correlation_id, job_id)
);

-- Unlogged staging table for parallel extraction before lock acquisition.
CREATE UNLOGGED TABLE extraction_staging (
    id BIGSERIAL PRIMARY KEY,
    correlation_id VARCHAR(21) NOT NULL,
    batch_id INT NOT NULL,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    data_type VARCHAR(20) NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
