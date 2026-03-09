ALTER TABLE stats
    ADD COLUMN run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    ADD COLUMN type TEXT,
    ADD COLUMN data JSONB;

UPDATE stats
SET type = 'legacy.process_time',
    data = jsonb_build_object(
        'project_id', project_id,
        'amount', amount,
        'duration', duration,
        'stat_type', stat_type
    )
WHERE type IS NULL;

ALTER TABLE stats
    ALTER COLUMN type SET NOT NULL,
    ALTER COLUMN data SET NOT NULL,
    ALTER COLUMN data SET DEFAULT '{}'::jsonb;

ALTER TABLE stats
    DROP COLUMN project_id,
    DROP COLUMN amount,
    DROP COLUMN duration,
    DROP COLUMN stat_type,
    DROP COLUMN updated_at;

CREATE TABLE workflow_stats (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    correlation_id VARCHAR(21) NOT NULL,
    workflow_name TEXT NOT NULL,
    workflow_version TEXT NOT NULL DEFAULT '',
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    file_id BIGINT REFERENCES project_files(id) ON DELETE SET NULL,
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

DO $$
BEGIN
    IF to_regclass('public.project_batch_status') IS NOT NULL THEN
        EXECUTE $sql$
            INSERT INTO workflow_stats (
                run_id,
                project_id,
                correlation_id,
                workflow_name,
                workflow_version,
                subject_type,
                subject_id,
                file_id,
                operation,
                status,
                current_step,
                current_step_started_at,
                estimated_duration,
                prediction_sample_count,
                prediction_fallback_level,
                metrics,
                prediction,
                error_message,
                created_at,
                updated_at,
                completed_at
            )
            SELECT
                NULL,
                pbs.project_id,
                pbs.correlation_id,
                CASE WHEN pbs.operation = 'delete' THEN 'delete' ELSE 'process' END,
                'v1',
                'file',
                COALESCE((pbs.file_ids[1])::text, pbs.batch_id::text),
                pbs.file_ids[1],
                pbs.operation,
                pbs.status,
                CASE pbs.status
                    WHEN 'preprocessing' THEN 'preprocess'
                    WHEN 'extracting_metadata' THEN 'metadata'
                    WHEN 'chunking' THEN 'chunk'
                    WHEN 'extracting_graph' THEN 'extract'
                    WHEN 'deduplicating' THEN 'dedupe'
                    WHEN 'saving' THEN 'save'
                    WHEN 'describing' THEN 'descriptions'
                    ELSE ''
                END,
                pbs.started_at,
                pbs.estimated_duration,
                0,
                0,
                '{}'::jsonb,
                jsonb_build_object('total_ms', pbs.estimated_duration),
                COALESCE(pbs.error_message, ''),
                pbs.created_at,
                COALESCE(pbs.completed_at, pbs.created_at),
                pbs.completed_at
            FROM project_batch_status pbs
        $sql$;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.project_description_job_status') IS NOT NULL THEN
        EXECUTE $sql$
            INSERT INTO workflow_stats (
                run_id,
                project_id,
                correlation_id,
                workflow_name,
                workflow_version,
                subject_type,
                subject_id,
                file_id,
                operation,
                status,
                current_step,
                current_step_started_at,
                estimated_duration,
                prediction_sample_count,
                prediction_fallback_level,
                metrics,
                prediction,
                error_message,
                created_at,
                updated_at,
                completed_at
            )
            SELECT
                NULL,
                pds.project_id,
                pds.correlation_id,
                'description',
                'v1',
                'description',
                pds.job_id::text,
                NULL,
                '',
                pds.status,
                CASE WHEN pds.status = 'processing' THEN 'describe' ELSE '' END,
                pds.started_at,
                0,
                0,
                0,
                jsonb_strip_nulls(jsonb_build_object(
                    'entity_count', cardinality(COALESCE(pds.entity_ids, '{}'::bigint[])),
                    'relationship_count', cardinality(COALESCE(pds.relationship_ids, '{}'::bigint[]))
                )),
                '{}'::jsonb,
                COALESCE(pds.error_message, ''),
                pds.created_at,
                COALESCE(pds.completed_at, pds.created_at),
                pds.completed_at
            FROM project_description_job_status pds
        $sql$;
    END IF;
END $$;

DROP TABLE IF EXISTS workflow_file_history;
DROP TABLE IF EXISTS workflow_description_history;
DROP TABLE IF EXISTS project_description_job_status;
DROP TABLE IF EXISTS project_batch_status;

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
