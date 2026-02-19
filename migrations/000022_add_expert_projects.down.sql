DROP INDEX IF EXISTS graphs_graph_type_idx;
DROP INDEX IF EXISTS graphs_user_type_idx;
DROP INDEX IF EXISTS graphs_group_type_idx;

ALTER TABLE IF EXISTS graphs
    DROP CONSTRAINT IF EXISTS graphs_single_owner_check;

DO $$
DECLARE
    fallback_group_id BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM graphs WHERE group_id IS NULL) THEN
        SELECT id
        INTO fallback_group_id
        FROM groups
        ORDER BY id
        LIMIT 1;

        IF fallback_group_id IS NULL THEN
            INSERT INTO groups (name)
            VALUES ('Migrated Graphs')
            RETURNING id INTO fallback_group_id;
        END IF;

        UPDATE graphs
        SET group_id = fallback_group_id
        WHERE group_id IS NULL;
    END IF;
END;
$$;

ALTER TABLE graphs
    DROP COLUMN IF EXISTS hidden,
    DROP COLUMN IF EXISTS type,
    DROP COLUMN IF EXISTS description,
    DROP COLUMN IF EXISTS graph_id,
    DROP COLUMN IF EXISTS user_id;

ALTER TABLE graphs
    ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE graphs
    RENAME TO projects;
