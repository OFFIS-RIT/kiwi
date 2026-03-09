DROP INDEX IF EXISTS idx_workflow_step_attempts_completed;
DROP INDEX IF EXISTS idx_workflow_step_attempts_child;
DROP INDEX IF EXISTS idx_workflow_step_attempts_run;
DROP INDEX IF EXISTS idx_workflow_runs_root;
DROP INDEX IF EXISTS idx_workflow_runs_parent;
DROP INDEX IF EXISTS idx_workflow_runs_status_available;

DROP TABLE IF EXISTS workflow_step_attempts;
DROP TABLE IF EXISTS workflow_runs;
