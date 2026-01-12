-- Rollback: remove the correct indexes and recreate the incorrect ones
DROP INDEX IF EXISTS entity_sources_public_id_idx;
DROP INDEX IF EXISTS entity_sources_entity_id_idx;
DROP INDEX IF EXISTS entity_sources_embedding_idx;
DROP INDEX IF EXISTS relationship_sources_public_id_idx;
DROP INDEX IF EXISTS relationship_sources_relationship_id_idx;
DROP INDEX IF EXISTS relationship_sources_embedding_idx;
DROP INDEX IF EXISTS entities_project_id_idx;

-- Recreate the incorrectly named indexes on communities (original behavior)
CREATE INDEX IF NOT EXISTS entity_sources_public_id_index ON communities USING hash (public_id);
CREATE INDEX IF NOT EXISTS entity_sources_cosine_similarity_index ON communities USING diskann (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS relation_sources_public_id_index ON communities USING hash (public_id);
CREATE INDEX IF NOT EXISTS relation_sources_cosine_similarity_index ON communities USING diskann (embedding vector_cosine_ops);
