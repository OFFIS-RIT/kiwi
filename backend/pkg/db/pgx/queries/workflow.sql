-- name: CreateWorkflowRun :one
INSERT INTO workflow_runs (
    id,
    name,
    version,
    input,
    available_at,
    idempotency_key,
    parent_run_id,
    parent_step_name,
    root_run_id,
    retry_initial_interval_ms,
    retry_backoff_coefficient,
    retry_maximum_interval_ms,
    retry_maximum_attempts
) VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13
)
ON CONFLICT (name, version, idempotency_key) DO UPDATE
SET updated_at = workflow_runs.updated_at
RETURNING *;

-- name: GetWorkflowRun :one
SELECT * FROM workflow_runs
WHERE id = $1;

-- name: ClaimNextWorkflowRun :one
WITH next_run AS (
    SELECT id
    FROM workflow_runs
    WHERE status IN ('pending', 'running')
      AND available_at <= NOW()
    ORDER BY available_at ASC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE workflow_runs
SET status = 'running',
    worker_id = $1,
    lease_token = $3,
    available_at = $2,
    updated_at = NOW(),
    last_heartbeat_at = NOW(),
    attempt_count = CASE
        WHEN workflow_runs.status = 'pending'
            OR (workflow_runs.status = 'running' AND workflow_runs.wait_reason = '') THEN workflow_runs.attempt_count + 1
        ELSE workflow_runs.attempt_count
    END
FROM next_run
WHERE workflow_runs.id = next_run.id
RETURNING workflow_runs.*;

-- name: HeartbeatWorkflowRun :execrows
UPDATE workflow_runs
SET available_at = $3,
    updated_at = NOW(),
    last_heartbeat_at = NOW()
WHERE id = $1
  AND worker_id = $2
  AND lease_token = $4
  AND status = 'running';

-- name: CompleteWorkflowRun :execrows
UPDATE workflow_runs
SET output = $3,
    status = 'completed',
    error_message = '',
    worker_id = '',
    lease_token = '',
    wait_reason = '',
    sleep_until = NULL,
    available_at = NOW(),
    updated_at = NOW(),
    last_heartbeat_at = NOW()
WHERE id = $1
  AND worker_id = $2
  AND lease_token = $4
  AND status = 'running';

-- name: FailWorkflowRun :execrows
UPDATE workflow_runs
SET status = 'failed',
    error_message = $3,
    worker_id = '',
    lease_token = '',
    wait_reason = '',
    sleep_until = NULL,
    available_at = NOW(),
    updated_at = NOW(),
    last_heartbeat_at = NOW()
WHERE id = $1
  AND worker_id = $2
  AND lease_token = $4;

-- name: RescheduleWorkflowRun :execrows
UPDATE workflow_runs
SET status = $3::text,
    error_message = $5,
    worker_id = '',
    lease_token = '',
    wait_reason = $6,
    sleep_until = $7,
    available_at = $4,
    updated_at = NOW(),
    last_heartbeat_at = NOW()
WHERE id = $1
  AND worker_id = $2
  AND lease_token = $8;

-- name: CancelWorkflowRun :execrows
UPDATE workflow_runs
SET status = 'canceled',
    error_message = '',
    worker_id = '',
    lease_token = '',
    wait_reason = '',
    sleep_until = NULL,
    available_at = NOW(),
    updated_at = NOW(),
    last_heartbeat_at = NOW()
WHERE id = $1
  AND status IN ('pending', 'running');

-- name: CancelWorkflowRunsByProject :execrows
UPDATE workflow_runs
SET status = 'canceled',
    error_message = '',
    worker_id = '',
    lease_token = '',
    wait_reason = '',
    sleep_until = NULL,
    available_at = NOW(),
    updated_at = NOW(),
    last_heartbeat_at = NOW()
WHERE status IN ('pending', 'running')
  AND COALESCE(input->>'project_id', '') = sqlc.arg(project_id)::text;

-- name: ListWorkflowStepAttempts :many
SELECT * FROM workflow_step_attempts
WHERE run_id = $1
ORDER BY created_at ASC, id ASC;

-- name: CreateWorkflowStepAttempt :one
INSERT INTO workflow_step_attempts (
    id,
    run_id,
    run_attempt,
    step_name,
    step_index,
    step_type,
    status,
    input,
    output,
    error_message,
    attempt_number,
    next_attempt_at,
    sleep_until,
    child_run_id,
    completed_at
) SELECT
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13,
    $14,
    $15
WHERE EXISTS (
    SELECT 1
    FROM workflow_runs
    WHERE id = $2
      AND worker_id = $16
      AND lease_token = $17
      AND status = 'running'
)
RETURNING *;
