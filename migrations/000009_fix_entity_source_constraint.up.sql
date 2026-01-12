-- Drop overly strict source constraints and fix index targets
ALTER TABLE entity_sources
    DROP CONSTRAINT IF EXISTS entity_sources_public_id_key;

ALTER TABLE relationship_sources
    DROP CONSTRAINT IF EXISTS relationship_sources_public_id_key;

DROP INDEX IF EXISTS entity_sources_public_id_index;
DROP INDEX IF EXISTS entity_sources_cosine_similarity_index;
DROP INDEX IF EXISTS relation_sources_public_id_index;
DROP INDEX IF EXISTS relation_sources_cosine_similarity_index;

CREATE INDEX IF NOT EXISTS entity_sources_public_id_index
    ON entity_sources USING hash (public_id);
CREATE INDEX IF NOT EXISTS entity_sources_cosine_similarity_index
    ON entity_sources USING diskann (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS relationship_sources_public_id_index
    ON relationship_sources USING hash (public_id);
CREATE INDEX IF NOT EXISTS relationship_sources_cosine_similarity_index
    ON relationship_sources USING diskann (embedding vector_cosine_ops);
