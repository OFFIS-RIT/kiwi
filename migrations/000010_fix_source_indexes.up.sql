-- Fix indexes that were incorrectly created on communities table
-- instead of entity_sources and relationship_sources tables

-- Drop the incorrectly named indexes from communities (if they exist)
DROP INDEX IF EXISTS entity_sources_public_id_index;
DROP INDEX IF EXISTS entity_sources_cosine_similarity_index;
DROP INDEX IF EXISTS relation_sources_public_id_index;
DROP INDEX IF EXISTS relation_sources_cosine_similarity_index;

-- Create correct indexes on entity_sources
CREATE INDEX IF NOT EXISTS entity_sources_public_id_idx ON entity_sources USING hash (public_id);
CREATE INDEX IF NOT EXISTS entity_sources_entity_id_idx ON entity_sources (entity_id);
CREATE INDEX IF NOT EXISTS entity_sources_embedding_idx ON entity_sources USING diskann (embedding vector_cosine_ops);

-- Create correct indexes on relationship_sources
CREATE INDEX IF NOT EXISTS relationship_sources_public_id_idx ON relationship_sources USING hash (public_id);
CREATE INDEX IF NOT EXISTS relationship_sources_relationship_id_idx ON relationship_sources (relationship_id);
CREATE INDEX IF NOT EXISTS relationship_sources_embedding_idx ON relationship_sources USING diskann (embedding vector_cosine_ops);

-- Add missing index on entities.project_id for faster project-scoped queries
CREATE INDEX IF NOT EXISTS entities_project_id_idx ON entities (project_id);
