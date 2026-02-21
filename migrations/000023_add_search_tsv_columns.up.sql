ALTER TABLE entities
ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
) STORED;

ALTER TABLE relationships
ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(description, '')), 'A')
) STORED;

CREATE INDEX IF NOT EXISTS entities_search_tsv_idx
ON entities USING gin (search_tsv);

CREATE INDEX IF NOT EXISTS relationships_search_tsv_idx
ON relationships USING gin (search_tsv);
