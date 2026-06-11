-- Drizzle generated a full CREATE TABLE here because the snapshots of
-- 20260609074758_cooing_storm and 20260610181652_thin_tombstone forked from the
-- same parent; the "models" table already exists, so only the new column is added.
-- Existing models predate per-model context windows, so they are backfilled with
-- 250000 (the previous global application default). Adjust per model afterwards.
ALTER TABLE "models" ADD COLUMN "context_window" integer DEFAULT 250000 NOT NULL;
