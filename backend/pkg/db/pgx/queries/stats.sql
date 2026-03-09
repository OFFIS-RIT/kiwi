-- name: InsertStatSample :exec
INSERT INTO stats (id, type, run_id, data)
VALUES ($1, $2, $3, $4);

-- name: PredictWorkflowStepDurationsExact :one
SELECT
    COUNT(DISTINCT run_id)::int AS sample_count,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'preprocess'), 0)::bigint AS preprocess_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'metadata'), 0)::bigint AS metadata_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'chunk'), 0)::bigint AS chunk_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'extract'), 0)::bigint AS extract_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'dedupe'), 0)::bigint AS dedupe_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name IN ('save', 'delete')), 0)::bigint AS save_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name IN ('describe', 'descriptions')), 0)::bigint AS describe_ms,
    COALESCE(SUM(duration_ms) FILTER (WHERE step_name = 'preprocess'), 0)::bigint AS total_duration_hint
FROM stats_workflow_step_samples_v
WHERE workflow_name = $1
  AND workflow_version = $2
  AND operation = $3
  AND file_type = $4
  AND ai_adapter = $5
  AND chat_model = $6
  AND needs_ocr = $7
  AND token_bucket BETWEEN $8 AND $9
  AND ($10 < 0 OR chunk_bucket BETWEEN $10 AND $11);

-- name: PredictWorkflowStepDurationsByFileType :one
SELECT
    COUNT(DISTINCT run_id)::int AS sample_count,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'preprocess'), 0)::bigint AS preprocess_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'metadata'), 0)::bigint AS metadata_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'chunk'), 0)::bigint AS chunk_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'extract'), 0)::bigint AS extract_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'dedupe'), 0)::bigint AS dedupe_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name IN ('save', 'delete')), 0)::bigint AS save_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name IN ('describe', 'descriptions')), 0)::bigint AS describe_ms,
    COALESCE(SUM(duration_ms) FILTER (WHERE step_name = 'preprocess'), 0)::bigint AS total_duration_hint
FROM stats_workflow_step_samples_v
WHERE workflow_name = $1
  AND workflow_version = $2
  AND operation = $3
  AND file_type = $4
  AND needs_ocr = $5
  AND token_bucket BETWEEN $6 AND $7;

-- name: PredictWorkflowStepDurationsByWorkflow :one
SELECT
    COUNT(DISTINCT run_id)::int AS sample_count,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'preprocess'), 0)::bigint AS preprocess_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'metadata'), 0)::bigint AS metadata_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'chunk'), 0)::bigint AS chunk_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'extract'), 0)::bigint AS extract_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name = 'dedupe'), 0)::bigint AS dedupe_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name IN ('save', 'delete')), 0)::bigint AS save_ms,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE step_name IN ('describe', 'descriptions')), 0)::bigint AS describe_ms,
    COALESCE(SUM(duration_ms) FILTER (WHERE step_name = 'preprocess'), 0)::bigint AS total_duration_hint
FROM stats_workflow_step_samples_v
WHERE workflow_name = $1
  AND workflow_version = $2
  AND operation = $3;

-- name: PredictDescriptionDurationExact :one
SELECT
    COUNT(DISTINCT run_id)::int AS sample_count,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::bigint AS total_ms
FROM stats_workflow_step_samples_v
WHERE type = 'workflow.description.describe'
  AND workflow_version = $1
  AND ai_adapter = $2
  AND chat_model = $3
  AND source_bucket BETWEEN $4 AND $5;

-- name: PredictDescriptionDurationByModel :one
SELECT
    COUNT(DISTINCT run_id)::int AS sample_count,
    COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::bigint AS total_ms
FROM stats_workflow_step_samples_v
WHERE type = 'workflow.description.describe'
  AND workflow_version = $1
  AND source_bucket BETWEEN $2 AND $3;
