-- Communities table
CREATE TABLE IF NOT EXISTS communities (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    rating FLOAT NOT NULL DEFAULT 0,
    explanation TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS communities_public_id_index ON communities USING hash (public_id);
CREATE INDEX IF NOT EXISTS communities_cosine_similarity_index ON communities USING diskann (embedding vector_cosine_ops);

-- Community entities junction table
CREATE TABLE IF NOT EXISTS community_entities (
    id BIGSERIAL PRIMARY KEY,
    entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    community_id BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE
);

DROP EXTENSION IF EXISTS postgis;
DROP EXTENSION IF EXISTS pgrouting;
