-- FactoryLogix Live Dashboard: initial schema (spec section 6).
-- Applied automatically by the API on start (see apps/api/src/db/migrate.ts).
-- TimescaleDB is used when available; every hypertable call is guarded so the schema also works on plain PostgreSQL.

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb extension not available (%). Continuing with plain PostgreSQL tables.', SQLERRM;
END $$;

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgcrypto extension not available (%).', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE cell_color AS ENUM ('blank','neutral','red','yellow','green','blue','visitor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fallback_source AS ENUM ('computed','fl_std_hr','none');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE adjustment_scope AS ENUM ('global','product','operation','product_operation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE override_scope AS ENUM ('product','product_operation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin','manager','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pin_mode AS ENUM ('force_eligible','force_visitor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Ingested (normalized) tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  product_number text PRIMARY KEY,
  name           text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operations (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_routes (
  product_number text NOT NULL REFERENCES products(product_number) ON DELETE CASCADE,
  operation_id   int  NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  sequence       int  NOT NULL,
  source         text NOT NULL DEFAULT 'derived',   -- 'mapped' | 'derived'
  PRIMARY KEY (product_number, operation_id)
);

CREATE TABLE IF NOT EXISTS operators (
  operator_id   text PRIMARY KEY,
  display_name  text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_orders (
  job_number     text PRIMARY KEY,
  product_number text NOT NULL,
  product_name   text,
  qty_released   int NOT NULL DEFAULT 0,
  qty_complete   int,
  status         text,
  fl_created_at  timestamptz,
  fl_modified_at timestamptz,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_orders_product_idx ON work_orders(product_number);
CREATE INDEX IF NOT EXISTS work_orders_modified_idx ON work_orders(fl_modified_at);

-- unit_steps: hypertable on start_ts. Unique key must include the partition column.
CREATE TABLE IF NOT EXISTS unit_steps (
  id             bigserial,
  unit_id        text NOT NULL,
  job_number     text NOT NULL,
  product_number text NOT NULL,
  operation_id   int  NOT NULL REFERENCES operations(id),
  operator_id    text NOT NULL,
  start_ts       timestamptz NOT NULL,
  complete_ts    timestamptz,
  result         text,
  rework_flag    boolean,
  fl_modified_at timestamptz,
  natural_key    text NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (natural_key, start_ts)
);
CREATE INDEX IF NOT EXISTS unit_steps_operator_start_idx  ON unit_steps(operator_id, start_ts);
CREATE INDEX IF NOT EXISTS unit_steps_job_op_complete_idx ON unit_steps(job_number, operation_id, complete_ts);
CREATE INDEX IF NOT EXISTS unit_steps_prod_op_complete_idx ON unit_steps(product_number, operation_id, complete_ts);
CREATE INDEX IF NOT EXISTS unit_steps_complete_idx        ON unit_steps(complete_ts);
CREATE INDEX IF NOT EXISTS unit_steps_start_idx           ON unit_steps(start_ts);

CREATE TABLE IF NOT EXISTS defects (
  id             bigserial,
  unit_id        text NOT NULL,
  job_number     text NOT NULL,
  operation_id   int  NOT NULL REFERENCES operations(id),
  operator_id    text,
  defect_code    text,
  description    text,
  found_ts       timestamptz NOT NULL,
  status         text,
  fl_modified_at timestamptz,
  natural_key    text NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (natural_key, found_ts)
);
CREATE INDEX IF NOT EXISTS defects_job_op_found_idx ON defects(job_number, operation_id, found_ts);
CREATE INDEX IF NOT EXISTS defects_found_idx ON defects(found_ts);

CREATE TABLE IF NOT EXISTS raw_events (
  id          bigserial,
  source      text NOT NULL,
  natural_key text NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_events_source_key_idx ON raw_events(source, natural_key, received_at DESC);

-- FactoryLogix-provided standard hours (fallback only)
CREATE TABLE IF NOT EXISTS fl_standards (
  product_number text NOT NULL,
  operation_id   int  NOT NULL REFERENCES operations(id),
  std_hr         numeric,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_number, operation_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  source               text PRIMARY KEY,
  watermark            text,
  last_success_at      timestamptz,
  last_error           text,
  consecutive_failures int NOT NULL DEFAULT 0,
  rows_last_poll       int,
  duration_ms_last_poll int,
  backfill_progress    jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_log (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows        int,
  status      text NOT NULL DEFAULT 'running',  -- running | ok | error
  error       text
);
CREATE INDEX IF NOT EXISTS sync_log_started_idx ON sync_log(started_at DESC);

-- Collector process heartbeat / breaker state (single row, id = 1)
CREATE TABLE IF NOT EXISTS collector_state (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  heartbeat_at       timestamptz,
  breaker_open_until timestamptz,
  status             text NOT NULL DEFAULT 'never',  -- ok | degraded | down | never
  last_error         text,
  last_success_at    timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_standards_recompute_at timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO collector_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Computed tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hour_cells (
  hour_start_utc  timestamptz NOT NULL,
  job_number      text NOT NULL,
  product_number  text NOT NULL,
  operation_id    int  NOT NULL REFERENCES operations(id),
  operator_id     text NOT NULL,
  units           int NOT NULL DEFAULT 0,
  work_minutes    numeric NOT NULL DEFAULT 0,
  window_minutes  numeric NOT NULL DEFAULT 0,
  break_minutes   numeric NOT NULL DEFAULT 0,
  charged_minutes numeric NOT NULL DEFAULT 0,
  eligible        boolean NOT NULL DEFAULT false,
  provisional     boolean NOT NULL DEFAULT true,
  std_hr          numeric,
  target_units    numeric NOT NULL DEFAULT 0,
  pace            numeric,
  color           cell_color NOT NULL DEFAULT 'blank',
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hour_start_utc, job_number, operation_id, operator_id)
);
CREATE INDEX IF NOT EXISTS hour_cells_job_idx      ON hour_cells(job_number, hour_start_utc);
CREATE INDEX IF NOT EXISTS hour_cells_operator_idx ON hour_cells(operator_id, hour_start_utc);
CREATE INDEX IF NOT EXISTS hour_cells_product_idx  ON hour_cells(product_number, operation_id, hour_start_utc);

CREATE TABLE IF NOT EXISTS defect_hour_cells (
  hour_start_utc timestamptz NOT NULL,
  job_number     text NOT NULL,
  operation_id   int NOT NULL REFERENCES operations(id),
  count          int NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_start_utc, job_number, operation_id)
);

CREATE TABLE IF NOT EXISTS operator_assignment_state (
  operator_id    text PRIMARY KEY,
  job_number     text,
  operation_id   int REFERENCES operations(id),
  assigned_since timestamptz,
  last_scan_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standards (
  product_number          text NOT NULL,
  operation_id            int NOT NULL REFERENCES operations(id),
  computed_std_hr         numeric,
  median_minutes_per_unit numeric,
  sample_units            int NOT NULL DEFAULT 0,
  sample_operators        int NOT NULL DEFAULT 0,
  sample_from             timestamptz,
  sample_to               timestamptz,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  fallback_source         fallback_source NOT NULL DEFAULT 'none',
  fl_std_hr               numeric,
  PRIMARY KEY (product_number, operation_id)
);

CREATE TABLE IF NOT EXISTS standards_history (
  id                      bigserial PRIMARY KEY,
  product_number          text NOT NULL,
  operation_id            int NOT NULL,
  computed_std_hr         numeric,
  median_minutes_per_unit numeric,
  sample_units            int NOT NULL DEFAULT 0,
  sample_operators        int NOT NULL DEFAULT 0,
  sample_from             timestamptz,
  sample_to               timestamptz,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  fallback_source         fallback_source NOT NULL DEFAULT 'none',
  fl_std_hr               numeric
);

CREATE TABLE IF NOT EXISTS standard_adjustments (
  id             serial PRIMARY KEY,
  scope          adjustment_scope NOT NULL,
  product_number text,
  operation_id   int REFERENCES operations(id),
  percent        numeric NOT NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  note           text,
  active         boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS standard_overrides (
  id             serial PRIMARY KEY,
  scope          override_scope NOT NULL,
  product_number text NOT NULL,
  operation_id   int REFERENCES operations(id),
  std_hr         numeric NOT NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  note           text,
  active         boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Configuration tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS displays (
  id                 serial PRIMARY KEY,
  pairing_code       char(4) NOT NULL UNIQUE,
  device_token       uuid NOT NULL UNIQUE,
  name               text,
  claimed_at         timestamptz,
  job_number         text,
  group_operators    boolean NOT NULL DEFAULT false,
  show_std_day       boolean NOT NULL DEFAULT true,
  show_gauge         boolean NOT NULL DEFAULT true,
  shift_length_hours numeric NOT NULL DEFAULT 12,
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  start_local    time NOT NULL,
  end_local      time NOT NULL,
  days_of_week   int[] NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS breaks (
  id               serial PRIMARY KEY,
  name             text NOT NULL,
  start_local      time NOT NULL,
  duration_minutes int NOT NULL,
  days_of_week     int[] NOT NULL,
  shift_ids        int[],
  effective_from   date NOT NULL,
  effective_to     date,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'viewer',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   int REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  "before"  jsonb,
  "after"   jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS operator_pins (
  id           serial PRIMARY KEY,
  operator_id  text NOT NULL,
  job_number   text NOT NULL,
  operation_id int REFERENCES operations(id),
  mode         pin_mode NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);
CREATE INDEX IF NOT EXISTS operator_pins_operator_idx ON operator_pins(operator_id, job_number);

-- ---------------------------------------------------------------------------
-- TimescaleDB hypertables + compression (guarded: works without the extension)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('unit_steps', 'start_ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('defects', 'found_ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('raw_events', 'received_at', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('hour_cells', 'hour_start_utc', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE, migrate_data => TRUE);

    BEGIN
      ALTER TABLE unit_steps SET (timescaledb.compress, timescaledb.compress_segmentby = 'job_number, operation_id', timescaledb.compress_orderby = 'start_ts');
      PERFORM add_compression_policy('unit_steps', INTERVAL '7 days', if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'unit_steps compression not configured: %', SQLERRM; END;

    BEGIN
      ALTER TABLE defects SET (timescaledb.compress, timescaledb.compress_segmentby = 'job_number', timescaledb.compress_orderby = 'found_ts');
      PERFORM add_compression_policy('defects', INTERVAL '7 days', if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'defects compression not configured: %', SQLERRM; END;

    BEGIN
      ALTER TABLE raw_events SET (timescaledb.compress, timescaledb.compress_segmentby = 'source', timescaledb.compress_orderby = 'received_at');
      PERFORM add_compression_policy('raw_events', INTERVAL '7 days', if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'raw_events compression not configured: %', SQLERRM; END;

    BEGIN
      ALTER TABLE hour_cells SET (timescaledb.compress, timescaledb.compress_segmentby = 'job_number', timescaledb.compress_orderby = 'hour_start_utc');
      PERFORM add_compression_policy('hour_cells', INTERVAL '30 days', if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'hour_cells compression not configured: %', SQLERRM; END;
  ELSE
    RAISE NOTICE 'timescaledb extension not available; using plain tables';
  END IF;
END $$;
