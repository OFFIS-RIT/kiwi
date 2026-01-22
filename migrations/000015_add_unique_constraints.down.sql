-- Rollback unique constraints
ALTER TABLE text_units
DROP CONSTRAINT IF EXISTS text_units_public_id_key;

ALTER TABLE entity_sources
DROP CONSTRAINT IF EXISTS entity_sources_public_id_key;

ALTER TABLE relationship_sources
DROP CONSTRAINT IF EXISTS relationship_sources_public_id_key;
