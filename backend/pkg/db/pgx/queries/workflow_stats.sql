-- name: CreateWorkflowStat :one
INSERT INTO workflow_stats (
    id,
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
    estimated_duration,
    prediction_sample_count,
    prediction_fallback_level,
    metrics,
    prediction,
    error_message
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
)
ON CONFLICT (correlation_id, subject_type, subject_id) DO UPDATE
SET run_id = EXCLUDED.run_id,
    project_id = EXCLUDED.project_id,
    workflow_name = EXCLUDED.workflow_name,
    workflow_version = EXCLUDED.workflow_version,
    file_id = EXCLUDED.file_id,
    operation = EXCLUDED.operation,
    status = EXCLUDED.status,
    current_step = EXCLUDED.current_step,
    estimated_duration = EXCLUDED.estimated_duration,
    prediction_sample_count = EXCLUDED.prediction_sample_count,
    prediction_fallback_level = EXCLUDED.prediction_fallback_level,
    metrics = EXCLUDED.metrics,
    prediction = EXCLUDED.prediction,
    error_message = EXCLUDED.error_message,
    updated_at = NOW()
RETURNING *;

-- name: GetWorkflowStatByRunID :one
SELECT * FROM workflow_stats
WHERE run_id = $1;

-- name: UpdateWorkflowStatStep :exec
UPDATE workflow_stats
SET status = $2,
    current_step = $3,
    current_step_started_at = CASE WHEN $3 = '' THEN NULL ELSE NOW() END,
    error_message = '',
    completed_at = NULL,
    updated_at = NOW()
WHERE run_id = $1;

-- name: UpdateWorkflowStatMetrics :exec
UPDATE workflow_stats
SET metrics = $2::jsonb,
    updated_at = NOW()
WHERE run_id = $1;

-- name: UpdateWorkflowStatPrediction :exec
UPDATE workflow_stats
SET estimated_duration = $2,
    prediction_sample_count = $3,
    prediction_fallback_level = $4,
    prediction = $5::jsonb,
    updated_at = NOW()
WHERE run_id = $1;

-- name: CompleteWorkflowStat :exec
UPDATE workflow_stats
SET status = $2,
    current_step = '',
    current_step_started_at = NULL,
    error_message = '',
    completed_at = NOW(),
    updated_at = NOW()
WHERE run_id = $1;

-- name: FailWorkflowStat :exec
UPDATE workflow_stats
SET status = 'failed',
    current_step = '',
    current_step_started_at = NULL,
    error_message = $2,
    completed_at = NOW(),
    updated_at = NOW()
WHERE run_id = $1;

-- name: GetWorkflowStatsByCorrelationAndSubjectType :many
SELECT * FROM workflow_stats
WHERE correlation_id = $1 AND subject_type = $2
ORDER BY created_at, id;

-- name: AreAllWorkflowStatsCompletedBySubjectType :one
SELECT (COUNT(*) > 0 AND COUNT(*) FILTER (WHERE status != 'completed') = 0)::bool AS all_completed
FROM workflow_stats
WHERE correlation_id = $1 AND subject_type = $2;

-- name: GetLatestCorrelationForProject :one
SELECT correlation_id
FROM workflow_stats
WHERE project_id = $1
GROUP BY correlation_id
ORDER BY MIN(created_at) DESC, MAX(id) DESC
LIMIT 1;

-- name: GetLatestWorkflowStatsForFiles :many
SELECT DISTINCT ON (file_id)
    file_id,
    status
FROM workflow_stats
WHERE project_id = $1
  AND file_id = ANY($2::text[])
ORDER BY file_id, created_at DESC, id DESC;

-- name: GetProjectFullProgress :one
WITH file_rows AS (
    SELECT
        ws.*,
        COALESCE((ws.prediction->>'preprocess_ms')::bigint, 0) AS preprocess_ms,
        COALESCE((ws.prediction->>'metadata_ms')::bigint, 0) AS metadata_ms,
        COALESCE((ws.prediction->>'chunk_ms')::bigint, 0) AS chunk_ms,
        COALESCE((ws.prediction->>'extract_ms')::bigint, 0) AS extract_ms,
        COALESCE((ws.prediction->>'dedupe_ms')::bigint, 0) AS dedupe_ms,
        COALESCE((ws.prediction->>'save_ms')::bigint, 0) AS save_ms,
        COALESCE((ws.prediction->>'describe_ms')::bigint, 0) AS describe_ms,
        GREATEST((EXTRACT(EPOCH FROM (NOW() - COALESCE(ws.current_step_started_at, ws.created_at))) * 1000)::bigint, 0) AS elapsed_ms
    FROM workflow_stats ws
    WHERE ws.correlation_id = $1
      AND ws.subject_type = 'file'
),
file_agg AS (
    SELECT
        COALESCE(BOOL_OR(operation = 'delete'), FALSE)::bool AS has_delete_operation,
        COALESCE(BOOL_OR(operation <> 'delete'), FALSE)::bool AS has_process_operation,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE status = 'preprocessing')::int AS preprocessing_count,
        COUNT(*) FILTER (WHERE status = 'extracting_metadata')::int AS metadata_count,
        COUNT(*) FILTER (WHERE status = 'chunking')::int AS chunking_count,
        COUNT(*) FILTER (WHERE status = 'extracting_graph')::int AS extracting_count,
        COUNT(*) FILTER (WHERE status = 'deduplicating')::int AS deduplicating_count,
        COUNT(*) FILTER (WHERE status = 'saving')::int AS saving_count,
        COUNT(*) FILTER (WHERE status = 'describing')::int AS describing_count,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        COUNT(*)::int AS total_count,
        COALESCE(SUM(estimated_duration), 0)::bigint AS total_estimated_duration,
        COALESCE(SUM(
            CASE
                WHEN status IN ('completed', 'failed') THEN 0
                WHEN status = 'pending' THEN estimated_duration
                WHEN status = 'preprocessing' THEN GREATEST(preprocess_ms - elapsed_ms, 0) + metadata_ms + chunk_ms + extract_ms + dedupe_ms + save_ms + describe_ms
                WHEN status = 'extracting_metadata' THEN GREATEST(metadata_ms - elapsed_ms, 0) + chunk_ms + extract_ms + dedupe_ms + save_ms + describe_ms
                WHEN status = 'chunking' THEN GREATEST(chunk_ms - elapsed_ms, 0) + extract_ms + dedupe_ms + save_ms + describe_ms
                WHEN status = 'extracting_graph' THEN GREATEST(extract_ms - elapsed_ms, 0) + dedupe_ms + save_ms + describe_ms
                WHEN status = 'deduplicating' THEN GREATEST(dedupe_ms - elapsed_ms, 0) + save_ms + describe_ms
                WHEN status = 'saving' THEN GREATEST(save_ms - elapsed_ms, 0) + describe_ms
                WHEN status = 'describing' THEN GREATEST(describe_ms - elapsed_ms, 0)
                ELSE estimated_duration
            END
        ), 0)::bigint AS remaining_estimated_duration
    FROM file_rows
),
description_rows AS (
    SELECT
        ws.*,
        COALESCE((ws.prediction->>'describe_ms')::bigint, COALESCE((ws.prediction->>'total_ms')::bigint, 0)) AS describe_ms,
        GREATEST((EXTRACT(EPOCH FROM (NOW() - COALESCE(ws.current_step_started_at, ws.created_at))) * 1000)::bigint, 0) AS elapsed_ms
    FROM workflow_stats ws
    WHERE ws.correlation_id = $1
      AND ws.subject_type = 'description'
),
description_agg AS (
    SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE status IN ('processing', 'describing'))::int AS processing_count,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        COUNT(*)::int AS total_count,
        COALESCE(SUM(estimated_duration), 0)::bigint AS total_estimated_duration,
        COALESCE(SUM(
            CASE
                WHEN status IN ('completed', 'failed') THEN 0
                WHEN status = 'pending' THEN estimated_duration
                WHEN status IN ('processing', 'describing') THEN GREATEST(describe_ms - elapsed_ms, 0)
                ELSE estimated_duration
            END
        ), 0)::bigint AS remaining_estimated_duration
    FROM description_rows
),
prediction_info AS (
    SELECT
        COALESCE(MIN(prediction_sample_count), 0)::int AS min_sample_count,
        COALESCE(MAX(prediction_fallback_level), 0)::int AS max_fallback_level,
        COUNT(*)::int AS active_prediction_count
    FROM workflow_stats
    WHERE correlation_id = $1
      AND status NOT IN ('completed', 'failed')
)
SELECT
    file_agg.has_delete_operation AS batch_has_delete_operation,
    file_agg.has_process_operation AS batch_has_process_operation,
    file_agg.pending_count AS batch_pending_count,
    file_agg.preprocessing_count AS batch_preprocessing_count,
    file_agg.metadata_count AS batch_metadata_count,
    file_agg.chunking_count AS batch_chunking_count,
    file_agg.extracting_count AS batch_extracting_count,
    file_agg.deduplicating_count AS batch_deduplicating_count,
    file_agg.saving_count AS batch_saving_count,
    file_agg.describing_count AS batch_describing_count,
    file_agg.completed_count AS batch_completed_count,
    file_agg.failed_count AS batch_failed_count,
    file_agg.total_count AS batch_total_count,
    file_agg.total_estimated_duration AS batch_estimated_duration,
    file_agg.remaining_estimated_duration AS batch_remaining_estimated_duration,
    description_agg.total_estimated_duration AS description_estimated_duration,
    description_agg.remaining_estimated_duration AS description_remaining_estimated_duration,
    (file_agg.total_estimated_duration + description_agg.total_estimated_duration)::bigint AS total_estimated_duration,
    (file_agg.remaining_estimated_duration + description_agg.remaining_estimated_duration)::bigint AS remaining_estimated_duration,
    description_agg.pending_count AS description_pending_count,
    description_agg.processing_count AS description_processing_count,
    description_agg.completed_count AS description_completed_count,
    description_agg.failed_count AS description_failed_count,
    description_agg.total_count AS description_total_count,
    prediction_info.min_sample_count AS prediction_min_sample_count,
    prediction_info.max_fallback_level AS prediction_max_fallback_level,
    prediction_info.active_prediction_count AS prediction_active_count
FROM file_agg, description_agg, prediction_info;
