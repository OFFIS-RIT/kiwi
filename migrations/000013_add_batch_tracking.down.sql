-- Recreate project_process table
CREATE TABLE project_process (
    project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    percentage INT NOT NULL DEFAULT 0,
    current_step TEXT NOT NULL DEFAULT 'queued',
    estimated_duration BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drop batch tracking table
DROP TABLE IF EXISTS project_batch_status;
