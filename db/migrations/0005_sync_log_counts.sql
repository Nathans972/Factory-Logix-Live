-- Per-pull row counts (additive, idempotent).
--
-- `rows` is what FactoryLogix returned. `ingested` is what reached the normalized tables and
-- `skipped` what was dropped (a required field missing, or a product or operation that could not
-- be resolved). Both are NULL for pulls logged before this migration.
ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS ingested int;
ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS skipped int;
