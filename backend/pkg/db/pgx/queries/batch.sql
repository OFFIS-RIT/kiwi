-- name: CreateBatchStatus :one
INSERT INTO project_batch_status (
    project_id, correlation_id, batch_id, total_batches, files_count, file_ids, operation
) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: UpdateBatchStatus :exec
UPDATE project_batch_status
SET status = $3::text,
    started_at = CASE WHEN $3::text IN ('preprocessing', 'extracting', 'indexing') THEN NOW() ELSE started_at END,
    completed_at = CASE WHEN $3::text IN ('completed', 'failed') THEN NOW() ELSE completed_at END,
    error_message = $4
WHERE correlation_id = $1 AND batch_id = $2;

-- name: TryStartPreprocessBatch :one
UPDATE project_batch_status
SET status = 'preprocessing',
    started_at = NOW(),
    completed_at = NULL,
    error_message = NULL
WHERE correlation_id = $1
  AND batch_id = $2
  AND status IN ('pending', 'failed')
RETURNING true;

-- name: TryStartGraphBatch :one
UPDATE project_batch_status
SET status = 'extracting',
    started_at = NOW(),
    completed_at = NULL,
    error_message = NULL
WHERE correlation_id = $1
  AND batch_id = $2
  AND status IN ('preprocessed', 'failed')
RETURNING true;

-- name: GetBatchesByCorrelation :many
SELECT * FROM project_batch_status
WHERE correlation_id = $1
ORDER BY batch_id;

-- name: AreAllBatchesCompleted :one
SELECT (COUNT(*) FILTER (WHERE status != 'completed') = 0)::bool as all_completed
FROM project_batch_status
WHERE correlation_id = $1;

-- name: GetPendingBatchesForProject :many
SELECT * FROM project_batch_status
WHERE project_id = $1 AND status IN ('pending', 'preprocessing', 'preprocessed', 'extracting', 'indexing')
ORDER BY created_at;

-- name: GetStaleBatches :many
SELECT * FROM project_batch_status
WHERE status IN ('preprocessing', 'extracting', 'indexing')
  AND started_at < NOW() - INTERVAL '10 hours';

-- name: ResetStaleBatchToPending :exec
UPDATE project_batch_status
SET status = 'pending',
    started_at = NULL,
    error_message = 'Reset: stale preprocessing state'
WHERE id = $1 AND status = 'preprocessing';

-- name: ResetStaleBatchToPreprocessed :exec
UPDATE project_batch_status
SET status = 'preprocessed',
    started_at = NULL,
    error_message = 'Reset: stale indexing state'
WHERE id = $1 AND status = 'indexing';

-- name: ResetStaleBatchExtractingToPreprocessed :exec
UPDATE project_batch_status
SET status = 'preprocessed',
    started_at = NULL,
    error_message = 'Reset: stale extracting state'
WHERE id = $1 AND status = 'extracting';

-- name: ResetBatchToPending :exec
UPDATE project_batch_status
SET status = 'pending',
    started_at = NULL
WHERE correlation_id = $1 AND batch_id = $2 AND status = 'preprocessing';

-- name: ResetBatchToPreprocessed :exec
UPDATE project_batch_status
SET status = 'preprocessed',
    started_at = NULL
WHERE correlation_id = $1 AND batch_id = $2 AND status = 'indexing';

-- name: GetProjectFilesForBatch :many
SELECT * FROM project_files
WHERE id = ANY($1::bigint[]);

-- name: GetLatestBatchStatusForFiles :many
SELECT DISTINCT ON (f.file_id)
    f.file_id::bigint AS file_id,
    pbs.status
FROM project_batch_status AS pbs
JOIN LATERAL unnest(pbs.file_ids) AS f(file_id) ON true
WHERE pbs.project_id = sqlc.arg(project_id)
  AND pbs.file_ids && sqlc.arg(file_ids)::bigint[]
  AND f.file_id = ANY(sqlc.arg(file_ids)::bigint[])
ORDER BY f.file_id, pbs.created_at DESC, pbs.id DESC;

-- name: GetLatestCorrelationForProject :one
SELECT correlation_id FROM project_batch_status
WHERE project_id = $1
ORDER BY created_at DESC
LIMIT 1;

-- name: UpdateBatchEstimatedDuration :exec
UPDATE project_batch_status
SET estimated_duration = $3
WHERE correlation_id = $1 AND batch_id = $2;

-- name: CreateDescriptionJobStatus :one
INSERT INTO project_description_job_status (
    project_id, correlation_id, job_id, total_jobs, entity_ids, relationship_ids
) VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (correlation_id, job_id) DO UPDATE
SET total_jobs = EXCLUDED.total_jobs,
    entity_ids = EXCLUDED.entity_ids,
    relationship_ids = EXCLUDED.relationship_ids
RETURNING *;

-- name: UpdateDescriptionJobStatus :exec
UPDATE project_description_job_status
SET status = $3::text,
    started_at = CASE WHEN $3::text = 'processing' THEN NOW() ELSE started_at END,
    completed_at = CASE WHEN $3::text IN ('completed', 'failed') THEN NOW() ELSE completed_at END,
    error_message = $4
WHERE correlation_id = $1 AND job_id = $2;

-- name: TryStartDescriptionJob :one
UPDATE project_description_job_status
SET status = 'processing',
    started_at = NOW()
WHERE correlation_id = $1
  AND job_id = $2
  AND status IN ('pending', 'failed')
RETURNING true;

-- name: ResetDescriptionJobToPending :exec
UPDATE project_description_job_status
SET status = 'pending',
    started_at = NULL,
    error_message = NULL
WHERE correlation_id = $1 AND job_id = $2 AND status = 'processing';

-- name: GetDescriptionJobsByCorrelation :many
SELECT * FROM project_description_job_status
WHERE correlation_id = $1
ORDER BY job_id;

-- name: AreAllDescriptionJobsCompleted :one
SELECT (COUNT(*) FILTER (WHERE status != 'completed') = 0)::bool as all_completed
FROM project_description_job_status
WHERE correlation_id = $1;

-- name: GetProjectFullProgress :one
WITH batch AS (
    SELECT 
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE status = 'preprocessing')::int AS preprocessing_count,
        COUNT(*) FILTER (WHERE status = 'preprocessed')::int AS preprocessed_count,
        COUNT(*) FILTER (WHERE status = 'extracting')::int AS extracting_count,
        COUNT(*) FILTER (WHERE status = 'indexing')::int AS indexing_count,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        COUNT(*)::int AS total_count,
        COALESCE(SUM(estimated_duration), 0)::bigint AS total_estimated_duration,
        COALESCE(SUM(estimated_duration) FILTER (WHERE status NOT IN ('completed', 'failed')), 0)::bigint AS remaining_estimated_duration
    FROM project_batch_status
    WHERE project_batch_status.correlation_id = $1
),
desc_jobs AS (
    SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        COUNT(*)::int AS total_count
    FROM project_description_job_status
    WHERE project_description_job_status.correlation_id = $1
)
SELECT
    batch.pending_count AS batch_pending_count,
    batch.preprocessing_count AS batch_preprocessing_count,
    batch.preprocessed_count AS batch_preprocessed_count,
    batch.extracting_count AS batch_extracting_count,
    batch.indexing_count AS batch_indexing_count,
    batch.completed_count AS batch_completed_count,
    batch.failed_count AS batch_failed_count,
    batch.total_count AS batch_total_count,
    batch.total_estimated_duration,
    batch.remaining_estimated_duration,
    desc_jobs.pending_count AS description_pending_count,
    desc_jobs.processing_count AS description_processing_count,
    desc_jobs.completed_count AS description_completed_count,
    desc_jobs.failed_count AS description_failed_count,
    desc_jobs.total_count AS description_total_count
FROM batch, desc_jobs;
