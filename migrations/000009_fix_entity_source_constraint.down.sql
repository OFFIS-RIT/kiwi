-- Reintroduce original constraints and indexes
DROP INDEX IF EXISTS relationship_sources_cosine_similarity_index;
DROP INDEX IF EXISTS relationship_sources_public_id_index;
DROP INDEX IF EXISTS entity_sources_cosine_similarity_index;
DROP INDEX IF EXISTS entity_sources_public_id_index;

CREATE INDEX IF NOT EXISTS entity_sources_public_id_index
    ON communities USING hash (public_id);
CREATE INDEX IF NOT EXISTS entity_sources_cosine_similarity_index
    ON communities USING diskann (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS relation_sources_public_id_index
    ON communities USING hash (public_id);
CREATE INDEX IF NOT EXISTS relation_sources_cosine_similarity_index
    ON communities USING diskann (embedding vector_cosine_ops);

ALTER TABLE relationship_sources
    ADD CONSTRAINT relationship_sources_public_id_key UNIQUE (public_id);

ALTER TABLE entity_sources
    ADD CONSTRAINT entity_sources_public_id_key UNIQUE (public_id);
