/**
 * Red team (data integrity): remapping a watermark from a numeric id to a timestamp field (or to
 * none) reads the stored id as a year. sync_state keeps the watermark as text and nothing resets
 * it when the mapping is saved with another `watermark_field`, so a data source polled with a step
 * id has digits stored ("5000"). Once the watermark field is a timestamp (or "none", time-window
 * mode), the next poll parses those digits as a timestamp, and `Date.parse` reads digit-only text as
 * a year: the poll asks FactoryLogix for rows since 5000-01-01, gets none, and reports success while
 * no new rows arrive.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** The poll time: 2025-03-04 12:00 UTC. */
const NOW = 1_741_089_600_000;

/** sync_state / sync_log in memory. */
function fakePool() {
  const state = new Map<string, string | null>();
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sync_state WHERE source')) {
        const source = params[0] as string;
        if (!state.has(source)) return { rows: [], rowCount: 0 };
        const row = {
          source,
          watermark: state.get(source) ?? null,
          last_success_at: null,
          last_error: null,
          consecutive_failures: 0,
          rows_last_poll: null,
          duration_ms_last_poll: null,
          backfill_progress: null,
        };
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sync_state (source, watermark')) {
        const [source, watermark] = params as [string, string | null];
        state.set(source, watermark ?? state.get(source) ?? null);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, state };
}

/** A FactoryLogix that records every request and answers it with no rows, as for a lower bound in the year 5000. */
function fakeSource() {
  const requests: SourceRequest[] = [];
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: (_set, field) => (field === 'Modified' || field === 'Done' ? 'Edm.DateTimeOffset' : null),
    literal: (_set, _field, value) => (value.kind === 'timestamp' ? new Date(value.ms).toISOString() : String(value)),
    describe: () => '',
    fetchPage: async (req) => {
      requests.push(req);
      return { rows: [], nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

/** unit_steps remapped away from a numeric id watermark: to the `Modified` timestamp field, or to none (time-window mode). */
function remappedTo(watermarkField: string | null): MappingConfig {
  return {
    work_orders: null,
    unit_steps: {
      entity_set: 'UnitSteps',
      watermark_field: watermarkField,
      key: ['Id'],
      fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
    },
    defects: null,
    operators: null,
    routes: null,
    standards: null,
  } as unknown as MappingConfig;
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 };

describe('remapping a data source whose stored watermark is a numeric id', () => {
  // [stored id, new watermark_field, the timestamp field the filter is built on]
  it.each([
    ['5000', 'Modified', 'Modified'],
    ['48210', 'Modified', 'Modified'],
    ['5000', null, 'Done'],
  ])('does not read the stored id %s as a year (watermark field now %s)', async (storedId, watermarkField, filterField) => {
    const remapped = remappedTo(watermarkField);
    const db = fakePool();
    const src = fakeSource();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const ingestor = { ingest: async () => ({ received: 0, ingested: 0, skipped: 0, touched: [] }) } as unknown as Ingestor;
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, src.source);

    // unit_steps was polled with a numeric step id as its watermark (Edm.Int64 in $metadata), so
    // sync_state holds the highest id it read, as WatermarkTracker.serialize writes an id: digits.
    db.state.set('unit_steps', storedId);

    // Then the admin saves the mapping with another watermark field (Admin > Mapping, step 3).
    // PUT /api/admin/mapping writes only the mapping, and the collector keeps the sync_state row
    // when it reloads its configuration, so the next poll starts from the stored id. Read as a
    // timestamp, `Date.parse` takes digit-only text for a year: '5000' is 5000-01-01T00:00:00Z,
    // '48210' is +048210-01-01T00:00:00Z.
    const outcome = await poller.pollOnce(remapped, settings, NOW);

    // FactoryLogix answers the request (a real service answers a lower bound in the year 5000 with
    // no rows, not an error), so the poll is reported healthy: rows 0, no error, breaker closed.

    expect(outcome.ok).toBe(true);

    const request = src.requests.find((r) => r.entitySet === 'UnitSteps');
    const lowerBound = new RegExp(`${filterField} ge (\\S+)`).exec(request?.filter ?? '')?.[1];
    expect(lowerBound).toBeDefined();
    // The poll asks FactoryLogix for rows "since" the stored watermark. An id is not a point in time:
    // the lower bound must not lie in the future, or every real row is filtered out and nothing is fetched.
    expect(Date.parse(lowerBound as string)).toBeLessThanOrEqual(NOW);
  });
});
