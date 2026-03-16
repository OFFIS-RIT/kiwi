DROP VIEW IF EXISTS stats_workflow_step_samples_v;

DROP INDEX IF EXISTS idx_stats_description_lookup;
DROP INDEX IF EXISTS idx_stats_workflow_lookup;
DROP INDEX IF EXISTS idx_stats_type_created;
DROP INDEX IF EXISTS idx_workflow_stats_correlation_step_started;
DROP INDEX IF EXISTS idx_workflow_stats_correlation_status;
DROP INDEX IF EXISTS idx_workflow_stats_file_latest;
DROP INDEX IF EXISTS idx_workflow_stats_project_correlation;
DROP INDEX IF EXISTS idx_workflow_stats_project_created;
DROP INDEX IF EXISTS idx_workflow_stats_run_id;

DROP TABLE IF EXISTS workflow_stats;

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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    UNIQUE(correlation_id, batch_id)
);

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

CREATE TABLE workflow_file_history (
    id BIGSERIAL PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    workflow_version TEXT NOT NULL DEFAULT '',
    operation TEXT NOT NULL DEFAULT '',
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    file_type TEXT NOT NULL DEFAULT '',
    ai_adapter TEXT NOT NULL DEFAULT '',
    chat_model TEXT NOT NULL DEFAULT '',
    embed_model TEXT NOT NULL DEFAULT '',
    needs_ocr BOOLEAN NOT NULL DEFAULT FALSE,
    text_bytes BIGINT NOT NULL DEFAULT 0,
    text_chars BIGINT NOT NULL DEFAULT 0,
    estimated_tokens BIGINT NOT NULL DEFAULT 0,
    token_bucket INT NOT NULL DEFAULT 0,
    chunk_count INT NOT NULL DEFAULT 0,
    chunk_bucket INT NOT NULL DEFAULT 0,
    page_count INT NOT NULL DEFAULT 0,
    row_count INT NOT NULL DEFAULT 0,
    audio_duration_ms BIGINT NOT NULL DEFAULT 0,
    entity_count INT NOT NULL DEFAULT 0,
    entity_bucket INT NOT NULL DEFAULT 0,
    relationship_count INT NOT NULL DEFAULT 0,
    relationship_bucket INT NOT NULL DEFAULT 0,
    preprocess_ms BIGINT NOT NULL DEFAULT 0,
    metadata_ms BIGINT NOT NULL DEFAULT 0,
    chunk_ms BIGINT NOT NULL DEFAULT 0,
    extract_ms BIGINT NOT NULL DEFAULT 0,
    dedupe_ms BIGINT NOT NULL DEFAULT 0,
    save_ms BIGINT NOT NULL DEFAULT 0,
    describe_ms BIGINT NOT NULL DEFAULT 0,
    total_ms BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE workflow_description_history (
    id BIGSERIAL PRIMARY KEY,
    workflow_version TEXT NOT NULL DEFAULT '',
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    ai_adapter TEXT NOT NULL DEFAULT '',
    chat_model TEXT NOT NULL DEFAULT '',
    embed_model TEXT NOT NULL DEFAULT '',
    source_count INT NOT NULL DEFAULT 0,
    source_bucket INT NOT NULL DEFAULT 0,
    entity_count INT NOT NULL DEFAULT 0,
    relationship_count INT NOT NULL DEFAULT 0,
    total_ms BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE stats
    ADD COLUMN project_id BIGINT REFERENCES graphs(id) ON DELETE CASCADE,
    ADD COLUMN amount INT NOT NULL DEFAULT 0,
    ADD COLUMN duration BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN stat_type TEXT NOT NULL DEFAULT '',
    ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE stats
SET project_id = NULL,
    amount = COALESCE((data->>'amount')::int, 0),
    duration = COALESCE((data->>'duration')::bigint, 0),
    stat_type = COALESCE(data->>'stat_type', type),
    updated_at = created_at
WHERE type = 'legacy.process_time';

ALTER TABLE stats
    DROP COLUMN data,
    DROP COLUMN type,
    DROP COLUMN run_id;
