/**
 * Red team (data): the fall-back night in `local_no_offset` mode, through the real Poller. FactoryLogix
 * returns plant wall-clock times with no offset, in time order; the collector polls every 90 seconds
 * with the default 10-minute overlap and the hourly late-data re-pull, so most rows are read several
 * times, some of them just after the clock went back. Every read of every row must land on the
 * instant it happened: both passes through 01:00-01:59 keep their 12 units, and no row moves between
 * reads (unit_steps is unique on natural_key + start_ts, so a moved start would be a second row).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import type { Logger } from '../src/logger.js';
import { extractRecord, num, TimestampResolver } from '../src/mapping/extract.js';
import { isoLocalNaive } from '../src/odata/literals.js';
import type { Source } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

const MIN = 60_000;
const TZ = 'America/New_York';
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** sync_state (watermarks) and sync_log in memory. */
function fakePool(): Pool {
  const watermarks = new Map<string, string | null>();
  let logId = 0;
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM sync_state WHERE source')) {
      const source = params[0] as string;
      if (!watermarks.has(source)) return { rows: [], rowCount: 0 };
      return { rows: [{ source, watermark: watermarks.get(source), consecutive_failures: 0, backfill_progress: null }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO sync_state')) {
      const [source, watermark] = params as [string, string | null];
      watermarks.set(source, watermark ?? watermarks.get(source) ?? null);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: ++logId }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

/** One completion every 5 minutes, 00:00 EDT to 02:55 EST (04:00Z-07:55Z), each started 2 minutes before. */
const steps = Array.from({ length: 48 }, (_, i) => {
  const done = Date.parse('2026-11-01T04:00:00Z') + i * 5 * MIN;
  return { done, row: { StepId: `S-${i}`, Unit: `U-${i}`, Job: 'J-1', Product: 'P-1', Op: 'Weld', User: 'ann', Start: isoLocalNaive(done - 2 * MIN, TZ), Done: isoLocalNaive(done, TZ) } };
});

/** Serves the steps completed by `clock`, filtered on the instant (`Done ge/lt <ms>`) and in time order. */
function fakeSource(clock: { now: number }): Source {
  return {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: (_set, _field, value) => (value.kind === 'timestamp' ? String(value.ms) : String(value)),
    describe: () => '',
    fetchPage: async (req) => {
      if (req.entitySet !== 'UnitSteps' || (req.skip ?? 0) > 0) return { rows: [], nextLink: null };
      const from = Number(/ ge (\d+)/.exec(req.filter ?? '')?.[1] ?? 0);
      const to = Number(/ lt (\d+)/.exec(req.filter ?? '')?.[1] ?? Infinity);
      const rows = steps.filter((s) => s.done <= clock.now && s.done >= from && s.done < to).map((s) => ({ ...s.row }));
      return { rows, nextLink: null };
    },
    close: async () => undefined,
  };
}

const mapping = {
  work_orders: { entity_set: 'WorkOrders', watermark_field: 'Modified', key: ['Job'], fields: { job_number: 'Job', product_number: 'Product' } },
  unit_steps: {
    entity_set: 'UnitSteps',
    watermark_field: 'Done',
    key: ['StepId'],
    fields: { unit_id: 'Unit', job_number: 'Job', product_number: 'Product', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
  },
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

describe('local_no_offset fall-back night 2026-11-01 through overlapping polls', () => {
  it('reads every row, every time, at the instant it happened', async () => {
    const clock = { now: 0 };
    const timestamps = new TimestampResolver({ mode: 'local_no_offset', timezone: TZ });
    // Every read of every step, as the Ingestor parses it.
    const reads = new Map<string, { start: number | null; complete: number | null }[]>();
    const ingestor = {
      ingest: async (dataset: string, rows: Record<string, unknown>[]) => {
        if (dataset === 'unit_steps') {
          for (const row of rows) {
            const rec = extractRecord('unit_steps', row, mapping.unit_steps, { timestamps });
            const list = reads.get(rec.natural_key) ?? [];
            list.push({ start: num(rec.values, 'start_ts'), complete: num(rec.values, 'complete_ts') });
            reads.set(rec.natural_key, list);
          }
        }
        return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
      },
    } as unknown as Ingestor;
    const pool = fakePool();
    const poller = new Poller({ pool, log, ingestor, timestamps }, fakeSource(clock));
    const settings: Settings = { ...DEFAULT_SETTINGS, fl_timestamp_mode: 'local_no_offset', plant_timezone: TZ };

    for (let now = Date.parse('2026-11-01T04:00:30Z'); now <= Date.parse('2026-11-01T08:00:00Z'); now += settings.poll_interval_seconds * 1000) {
      clock.now = now;
      const outcome = await poller.pollOnce(mapping, settings, now);
      expect(outcome.ok).toBe(true);
    }

    for (const { done, row } of steps) {
      const got = reads.get(row.StepId) ?? [];
      expect(got.length, row.StepId).toBeGreaterThan(1);
      for (const read of got) expect(read, `${row.StepId} ${row.Done}`).toEqual({ start: done - 2 * MIN, complete: done });
    }
    const inHour = (hourUtc: string) => {
      const start = Date.parse(hourUtc);
      return [...reads.values()].filter((r) => {
        const complete = r.at(-1)?.complete ?? null;
        return complete !== null && complete >= start && complete < start + 60 * MIN;
      }).length;
    };
    expect(inHour('2026-11-01T05:00:00Z')).toBe(12); // 01:00-01:59 EDT
    expect(inHour('2026-11-01T06:00:00Z')).toBe(12); // 01:00-01:59 EST
  });
});
