CREATE INDEX entities_project_type_idx
    ON entities(project_id, type);

CREATE INDEX entities_project_name_idx
    ON entities(project_id, name);

CREATE INDEX entities_name_trgm_idx
    ON entities USING gin (name gin_trgm_ops);

CREATE INDEX relationships_project_source_target_idx
    ON relationships(project_id, source_id, target_id);

CREATE INDEX entity_sources_entity_id_id_idx
    ON entity_sources(entity_id, id);

CREATE INDEX entity_sources_text_unit_id_idx
    ON entity_sources(text_unit_id);

CREATE INDEX relationship_sources_relationship_id_id_idx
    ON relationship_sources(relationship_id, id);

CREATE INDEX relationship_sources_text_unit_id_idx
    ON relationship_sources(text_unit_id);

CREATE INDEX text_units_project_file_id_idx
    ON text_units(project_file_id);

CREATE INDEX project_files_project_deleted_idx
    ON project_files(project_id, deleted);

CREATE INDEX project_files_project_file_key_idx
    ON project_files(project_id, file_key);

CREATE INDEX group_users_user_group_idx
    ON group_users(user_id, group_id);

CREATE INDEX projects_group_id_idx
    ON projects(group_id);

CREATE INDEX idx_batch_status_project_status_created_at
    ON project_batch_status(project_id, status, created_at);

CREATE INDEX idx_batch_status_stale_started_at
    ON project_batch_status(started_at)
    WHERE status IN ('preprocessing', 'extracting', 'indexing');

CREATE INDEX idx_batch_status_project_created_at_desc
    ON project_batch_status(project_id, created_at DESC);

CREATE INDEX idx_batch_status_file_ids_gin
    ON project_batch_status USING gin(file_ids);

CREATE INDEX idx_extraction_staging_full_lookup
    ON extraction_staging(correlation_id, batch_id, project_id, data_type, id);

CREATE INDEX idx_stats_stat_type
    ON stats(stat_type);

CREATE INDEX idx_chat_messages_chat_id_user_assistant
    ON chat_messages(chat_id, id)
    WHERE role IN ('user', 'assistant');
