-- name: CreateBatchStatus :one
INSERT INTO project_batch_status (
    project_id, correlation_id, batch_id, total_batches, files_count, file_ids, operation
) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: UpdateBatchStatus :exec
UPDATE project_batch_status
SET status = $3,
    started_at = CASE WHEN $3 = 'preprocessing' OR $3 = 'indexing' THEN NOW() ELSE started_at END,
    completed_at = CASE WHEN $3 IN ('completed', 'failed') THEN NOW() ELSE completed_at END,
    error_message = $4
WHERE correlation_id = $1 AND batch_id = $2;

-- name: GetBatchStatus :one
SELECT * FROM project_batch_status
WHERE correlation_id = $1 AND batch_id = $2;

-- name: GetBatchesByCorrelation :many
SELECT * FROM project_batch_status
WHERE correlation_id = $1
ORDER BY batch_id;

-- name: CountCompletedBatches :one
SELECT COUNT(*)::int FROM project_batch_status
WHERE correlation_id = $1 AND status = 'completed';

-- name: AreAllBatchesCompleted :one
SELECT (COUNT(*) FILTER (WHERE status != 'completed') = 0)::bool as all_completed
FROM project_batch_status
WHERE correlation_id = $1;

-- name: GetPendingBatchesForProject :many
SELECT * FROM project_batch_status
WHERE project_id = $1 AND status IN ('pending', 'preprocessing', 'indexing')
ORDER BY created_at;

-- name: DeleteBatchStatusByCorrelation :exec
DELETE FROM project_batch_status WHERE correlation_id = $1;

-- name: DeleteOldCompletedBatches :exec
DELETE FROM project_batch_status 
WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '7 days';

-- name: GetStaleBatches :many
SELECT * FROM project_batch_status
WHERE status IN ('preprocessing', 'indexing')
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

-- name: GetLatestCorrelationForProject :one
SELECT correlation_id FROM project_batch_status
WHERE project_id = $1
ORDER BY created_at DESC
LIMIT 1;

-- name: GetProjectBatchProgress :one
SELECT 
    COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
    COUNT(*) FILTER (WHERE status = 'preprocessing')::int AS preprocessing_count,
    COUNT(*) FILTER (WHERE status = 'preprocessed')::int AS preprocessed_count,
    COUNT(*) FILTER (WHERE status = 'indexing')::int AS indexing_count,
    COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
    COUNT(*)::int AS total_count,
    COALESCE(SUM(estimated_duration), 0)::bigint AS total_estimated_duration,
    COALESCE(SUM(estimated_duration) FILTER (WHERE status NOT IN ('completed', 'failed')), 0)::bigint AS remaining_estimated_duration
FROM project_batch_status
WHERE correlation_id = $1;

-- name: UpdateBatchEstimatedDuration :exec
UPDATE project_batch_status
SET estimated_duration = $3
WHERE correlation_id = $1 AND batch_id = $2;
