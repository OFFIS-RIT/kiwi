CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    input JSONB NOT NULL,
    output JSONB NOT NULL DEFAULT 'null'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
    error_message TEXT NOT NULL DEFAULT '',
    attempt_count INT NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    worker_id TEXT NOT NULL DEFAULT '',
    lease_token TEXT NOT NULL DEFAULT '',
    wait_reason TEXT NOT NULL DEFAULT '',
    sleep_until TIMESTAMPTZ,
    idempotency_key TEXT,
    parent_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    parent_step_name TEXT,
    root_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    retry_initial_interval_ms BIGINT NOT NULL DEFAULT 1000,
    retry_backoff_coefficient DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    retry_maximum_interval_ms BIGINT NOT NULL DEFAULT 30000,
    retry_maximum_attempts INT NOT NULL DEFAULT 3,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name, version, idempotency_key)
);

CREATE TABLE workflow_step_attempts (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    run_attempt INT NOT NULL DEFAULT 1,
    step_name TEXT NOT NULL,
    step_index INT NOT NULL,
    step_type TEXT NOT NULL DEFAULT 'run' CHECK (step_type IN ('run', 'sleep', 'workflow')),
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
    input JSONB NOT NULL DEFAULT 'null'::jsonb,
    output JSONB NOT NULL DEFAULT 'null'::jsonb,
    error_message TEXT NOT NULL DEFAULT '',
    attempt_number INT NOT NULL DEFAULT 1,
    next_attempt_at TIMESTAMPTZ,
    sleep_until TIMESTAMPTZ,
    child_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_workflow_runs_status_available
    ON workflow_runs(status, available_at, created_at)
    WHERE status IN ('pending', 'running');

CREATE INDEX idx_workflow_runs_parent
    ON workflow_runs(parent_run_id);

CREATE INDEX idx_workflow_runs_root
    ON workflow_runs(root_run_id);

CREATE INDEX idx_workflow_step_attempts_run
    ON workflow_step_attempts(run_id, created_at, id);

CREATE INDEX idx_workflow_step_attempts_child
    ON workflow_step_attempts(child_run_id)
    WHERE child_run_id IS NOT NULL;

CREATE UNIQUE INDEX idx_workflow_step_attempts_completed
    ON workflow_step_attempts(run_id, step_name)
    WHERE status = 'completed';
