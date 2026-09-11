-- Collector support index (additive, idempotent).
--
-- The nightly standards job (spec 7.1) recomputes every (product, operation) that RECEIVED new
-- completed units since collector_state.last_standards_recompute_at, i.e. it filters unit_steps on
-- `updated_at`, which 0001_init.sql does not index. Without this index that nightly query degrades
-- into a full scan of the unit_steps hypertable (spec 14: load protection / performance).
CREATE INDEX IF NOT EXISTS unit_steps_updated_idx ON unit_steps(updated_at);
