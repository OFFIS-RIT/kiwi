-- name: UpsertProjectProcess :exec
INSERT INTO project_process (
    project_id,
    percentage,
    current_step,
    estimated_duration,
    updated_at
) VALUES (
    $1,
    $2,
    $3,
    $4,
    NOW()
)
ON CONFLICT (project_id) DO UPDATE SET
    percentage = EXCLUDED.percentage,
    current_step = EXCLUDED.current_step,
    estimated_duration = EXCLUDED.estimated_duration,
    updated_at = NOW();

-- name: UpdateProjectProcessStep :exec
UPDATE project_process 
SET 
    current_step = $2, 
    updated_at = NOW() 
WHERE project_id = $1;

-- name: UpdateProjectProcessStepOnly :exec
UPDATE project_process 
SET 
    current_step = $2
WHERE project_id = $1;

-- name: UpdateProjectProcessStepAndPrediction :exec
UPDATE project_process 
SET 
    current_step = $2, 
    estimated_duration = $3,
    percentage = 0,
    updated_at = NOW() 
WHERE project_id = $1;

-- name: UpdateProjectProcessPercentage :exec
UPDATE project_process 
SET 
    percentage = $2,
    updated_at = NOW() 
WHERE project_id = $1;

-- name: GetProjectProcess :one
SELECT 
    project_id,
    percentage,
    current_step,
    estimated_duration
FROM project_process 
WHERE project_id = $1;

-- name: DeleteProjectProcess :exec
DELETE FROM project_process 
WHERE project_id = $1;
