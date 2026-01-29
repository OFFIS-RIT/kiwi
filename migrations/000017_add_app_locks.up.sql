CREATE TABLE app_locks (
    lock_key TEXT PRIMARY KEY,
    locked_by TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_app_locks_expires_at ON app_locks(expires_at);
