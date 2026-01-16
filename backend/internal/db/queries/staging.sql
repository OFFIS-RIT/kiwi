-- name: InsertStagedData :exec
INSERT INTO extraction_staging (correlation_id, batch_id, project_id, data_type, data)
VALUES ($1, $2, $3, $4, $5);

-- name: GetStagedUnits :many
SELECT data
FROM extraction_staging
WHERE correlation_id = $1 AND batch_id = $2 AND data_type = 'unit'
ORDER BY id;

-- name: GetStagedEntities :many
SELECT data
FROM extraction_staging
WHERE correlation_id = $1 AND batch_id = $2 AND data_type = 'entity'
ORDER BY id;

-- name: GetStagedRelationships :many
SELECT data
FROM extraction_staging
WHERE correlation_id = $1 AND batch_id = $2 AND data_type = 'relationship'
ORDER BY id;

-- name: DeleteStagedData :exec
DELETE FROM extraction_staging
WHERE correlation_id = $1 AND batch_id = $2;

-- name: DeleteStagedDataByProject :exec
DELETE FROM extraction_staging
WHERE project_id = $1;

-- name: CleanupOldStagedData :exec
DELETE FROM extraction_staging
WHERE created_at < NOW() - INTERVAL '24 hours';
