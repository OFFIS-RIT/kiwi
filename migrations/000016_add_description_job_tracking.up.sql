-- Track parallel description generation jobs for a correlation
CREATE TABLE project_description_job_status (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

CREATE INDEX idx_desc_job_status_correlation ON project_description_job_status(correlation_id);
CREATE INDEX idx_desc_job_status_project ON project_description_job_status(project_id);
CREATE INDEX idx_desc_job_status_inflight ON project_description_job_status(status)
    WHERE status IN ('pending', 'processing');
