-- Raw payload de-duplication (additive, idempotent).
--
-- Every overlap re-pull, the hourly 24 h late-data re-pull and the backfill re-read rows the
-- collector has already seen. raw_events used to get a new row for each read; now the collector
-- keeps the sha256 of the last payload stored per (source, natural_key) here and only writes a
-- raw_events row when the key is new or its payload changed.
CREATE TABLE IF NOT EXISTS raw_event_hashes (
  source       text NOT NULL,
  natural_key  text NOT NULL,
  payload_hash text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, natural_key)
);
