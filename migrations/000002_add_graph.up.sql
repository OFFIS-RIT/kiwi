CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;

CREATE TABLE IF NOT EXISTS text_units (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL,
    project_file_id BIGINT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entities (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS entities_public_id_index ON entities USING hash (public_id);
CREATE INDEX IF NOT EXISTS entities_cosine_similarity_index ON entities USING diskann (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS relationships (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    source_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    rank FLOAT NOT NULL DEFAULT 0,
    embedding vector(4096) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS relationship_source_idx ON relationships (project_id, source_id);
CREATE INDEX IF NOT EXISTS relationship_target_idx ON relationships (project_id, target_id);
CREATE INDEX IF NOT EXISTS relationships_public_id_index ON relationships USING hash (public_id);
CREATE INDEX IF NOT EXISTS relationships_cosine_similarity_index ON relationships USING diskann (embedding vector_cosine_ops);

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

CREATE TABLE IF NOT EXISTS community_entities (
    id BIGSERIAL PRIMARY KEY,
    entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    community_id BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_sources (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    text_unit_id BIGINT NOT NULL REFERENCES text_units(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS entity_sources_public_id_index ON communities USING hash (public_id);
CREATE INDEX IF NOT EXISTS entity_sources_cosine_similarity_index ON communities USING diskann (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS relationship_sources (
    id BIGSERIAL PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    relationship_id BIGINT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
    text_unit_id BIGINT NOT NULL REFERENCES text_units(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    embedding vector(4096) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS relation_sources_public_id_index ON communities USING hash (public_id);
CREATE INDEX IF NOT EXISTS relation_sources_cosine_similarity_index ON communities USING diskann (embedding vector_cosine_ops);
