CREATE TABLE project_process (
    project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    percentage INT NOT NULL DEFAULT 0,
    current_step TEXT NOT NULL DEFAULT 'queued', -- queued, processing_files, graph_creation, generating_descriptions, saving, completed, failed
    estimated_duration BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
