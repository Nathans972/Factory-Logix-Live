-- Additive schema changes required by apps/api (see docs/API.md).
--
-- 1. unit_steps.operation_seq: the mapping spec (packages/shared/src/mapping.ts, dataset
--    `unit_steps`) exposes `operation_seq` as a source field and the shared `UnitStep` type carries
--    it, but 0001_init.sql has nowhere to store it. The API needs it to order a product's route when
--    `product_routes` is not mapped ("distinct operations ordered by min(operation_seq) nulls last,
--    then first seen").
-- 2. Indexes that keep the jobs list and per-job derived quantities cheap.

ALTER TABLE unit_steps ADD COLUMN IF NOT EXISTS operation_seq int;

CREATE INDEX IF NOT EXISTS unit_steps_job_start_idx ON unit_steps (job_number, start_ts DESC);
CREATE INDEX IF NOT EXISTS unit_steps_job_complete_desc_idx ON unit_steps (job_number, complete_ts DESC);
CREATE INDEX IF NOT EXISTS unit_steps_product_op_seq_idx ON unit_steps (product_number, operation_id, operation_seq);
CREATE INDEX IF NOT EXISTS defect_hour_cells_job_idx ON defect_hour_cells (job_number, hour_start_utc);
