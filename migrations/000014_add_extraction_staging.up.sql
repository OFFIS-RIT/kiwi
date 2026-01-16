CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE UNLOGGED TABLE extraction_staging (
    id BIGSERIAL PRIMARY KEY,
    correlation_id VARCHAR(21) NOT NULL,
    batch_id INT NOT NULL,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    data_type VARCHAR(20) NOT NULL CHECK (data_type IN ('unit', 'entity', 'relationship')),
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_extraction_staging_lookup 
    ON extraction_staging(correlation_id, batch_id);
CREATE INDEX idx_extraction_staging_cleanup 
    ON extraction_staging(created_at);
CREATE INDEX idx_extraction_staging_project 
    ON extraction_staging(project_id);
SELECT cron.schedule(
    'cleanup-extraction-staging',
    '0 * * * *',
    $$DELETE FROM extraction_staging WHERE created_at < NOW() - INTERVAL '24 hours'$$
);
