ALTER TABLE IF EXISTS projects
    RENAME TO graphs;

ALTER TABLE graphs
    ALTER COLUMN group_id DROP NOT NULL;

ALTER TABLE graphs
    ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS graph_id BIGINT REFERENCES graphs(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS type TEXT,
    ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE graphs
    DROP CONSTRAINT IF EXISTS graphs_single_owner_check,
    ADD CONSTRAINT graphs_single_owner_check CHECK (
        ((group_id IS NOT NULL)::INT + (user_id IS NOT NULL)::INT + (graph_id IS NOT NULL)::INT) <= 1
    );

CREATE INDEX IF NOT EXISTS graphs_group_type_idx
    ON graphs (group_id, type);

CREATE INDEX IF NOT EXISTS graphs_user_type_idx
    ON graphs (user_id, type);

CREATE INDEX IF NOT EXISTS graphs_graph_type_idx
    ON graphs (graph_id, type);
