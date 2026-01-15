-- Batch tracking table for parallel worker processing
-- Replaces project_process table with per-batch progress tracking
CREATE TABLE project_batch_status (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

CREATE INDEX idx_batch_status_correlation ON project_batch_status(correlation_id);
CREATE INDEX idx_batch_status_project ON project_batch_status(project_id);
CREATE INDEX idx_batch_status_pending ON project_batch_status(status) WHERE status IN ('pending', 'preprocessing', 'indexing');

-- Drop project_process table (progress now tracked via project_batch_status)
DROP TABLE IF EXISTS project_process;
