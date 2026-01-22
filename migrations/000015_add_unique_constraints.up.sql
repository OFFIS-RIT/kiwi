-- Add unique constraints required for ON CONFLICT DO UPDATE in insert queries
ALTER TABLE text_units
ADD CONSTRAINT text_units_public_id_key UNIQUE (public_id);

ALTER TABLE entity_sources
ADD CONSTRAINT entity_sources_public_id_key UNIQUE (public_id);

ALTER TABLE relationship_sources
ADD CONSTRAINT relationship_sources_public_id_key UNIQUE (public_id);
