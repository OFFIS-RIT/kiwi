DROP INDEX IF EXISTS relationships_search_tsv_idx;
DROP INDEX IF EXISTS entities_search_tsv_idx;

ALTER TABLE relationships
DROP COLUMN IF EXISTS search_tsv;

ALTER TABLE entities
DROP COLUMN IF EXISTS search_tsv;
