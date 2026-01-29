-- name: PredictProjectProcessTime :one
SELECT (
    (SUM(duration)::DOUBLE PRECISION / NULLIF(SUM(amount), 0)) * $1
)::BIGINT AS predicted_duration
FROM stats
WHERE stat_type = $2;

-- name: AddProcessTime :exec
INSERT INTO stats 
    (project_id, amount, duration, stat_type)
VALUES
    ($1, $2, $3, $4);
