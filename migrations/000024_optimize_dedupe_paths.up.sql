CREATE INDEX IF NOT EXISTS entities_dedupe_project_type_id_idx
    ON entities(project_id, type, id)
    WHERE type NOT IN ('FACT', 'FILE');

CREATE INDEX IF NOT EXISTS entities_dedupe_name_trgm_idx
    ON entities USING gin (name gin_trgm_ops)
    WHERE type NOT IN ('FACT', 'FILE');

CREATE INDEX IF NOT EXISTS relationships_project_source_id_idx
    ON relationships(project_id, source_id);

CREATE INDEX IF NOT EXISTS relationships_project_target_id_idx
    ON relationships(project_id, target_id);
