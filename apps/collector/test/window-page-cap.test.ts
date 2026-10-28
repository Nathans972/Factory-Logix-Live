/**
 * A window pull that reaches the page cap reads on from where it stopped (proof in
 * window-truncation.test.ts). Here, against a service that honours the filter: a backfill day, the
 * late-data re-pull and a whole data source bigger than one pass are read whole; a window that
 * cannot be read on (more rows at one timestamp than a pass reads, a service that ignores `$skip`)
 * fails where it shows instead of counting as read.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BackfillProgress, type DatasetMapping, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Backfill } from '../src/sync/backfill.js';
import { Poller } from '../src/sync/poller.js';

type Row = Record<string, unknown>;

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

interface StateRow {
  watermark: string | null;
  last_error: string | null;
  consecutive_failures: number;
  rows_last_poll: number | null;
  backfill_progress: BackfillProgress | null;
}

/** sync_state (backfill progress included) and sync_log in memory. */
function fakePool() {
  const state = new Map<string, StateRow>();
  const syncLog: { source: string; rows?: number; status?: string; error?: string | null }[] = [];
  const row = (source: string): StateRow =>
    state.get(source) ?? { watermark: null, last_error: null, consecutive_failures: 0, rows_last_poll: null, backfill_progress: null };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sync_state WHERE source')) {
        const found = state.get(params[0] as string);
        return { rows: found ? [{ source: params[0], last_success_at: null, duration_ms_last_poll: null, ...structuredClone(found) }] : [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sync_state (source, backfill_progress')) {
        state.set('backfill', { ...row('backfill'), backfill_progress: JSON.parse(params[0] as string) as BackfillProgress });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sync_state (source, watermark, last_success_at')) {
        const [source, watermark, rows] = params as [string, string | null, number];
        const r = row(source);
        state.set(source, { ...r, watermark: watermark ?? r.watermark, last_error: null, consecutive_failures: 0, rows_last_poll: rows });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sync_state (source, watermark, last_error')) {
        const [source, error, , watermark] = params as [string, string, number, string | null];
        const r = row(source);
        state.set(source, { ...r, watermark: watermark ?? r.watermark, last_error: error, consecutive_failures: r.consecutive_failures + 1 });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO sync_log')) {
        syncLog.push({ source: params[0] as string });
        return { rows: [{ id: syncLog.length }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE sync_log')) {
        Object.assign(syncLog[(params[0] as number) - 1] ?? {}, { rows: params[1], status: params[2], error: params[3] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, state, syncLog };
}

/**
 * Tables behind `$filter=(<field> ge <ts>) and (<field> lt <ts>)`, ordered on that field, with
 * `$top`/`$skip`. A table with no field is served by `$top`/`$skip` alone; `ignoreSkip` answers
 * every request from the top.
 */
function liveSource(tables: Record<string, { field: string | null; rows: Row[] }>, opts: { ignoreSkip?: boolean } = {}) {
  const requests: SourceRequest[] = [];
  const sorted = Object.fromEntries(
    Object.entries(tables).map(([set, { field, rows }]) => {
      const ordered = field ? [...rows].sort((a, b) => Date.parse(String(a[field])) - Date.parse(String(b[field]))) : rows;
      return [set, { rows: ordered, ms: field ? ordered.map((r) => Date.parse(String(r[field]))) : [] }];
    }),
  );
  /** The first index at or after `bound`. */
  const firstFrom = (ms: number[], bound: number) => {
    let lo = 0;
    let hi = ms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((ms[mid] as number) < bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: (_set, _field, value) => {
      if (value.kind !== 'timestamp') throw new Error('timestamp literal expected');
      return new Date(value.ms).toISOString();
    },
    describe: () => '',
    fetchPage: async (req) => {
      requests.push(req);
      const table = sorted[req.entitySet];
      if (!table) throw new Error(`unexpected entity set ${req.entitySet}`);
      let lo = 0;
      let hi = table.rows.length;
      for (const [, op, literal] of (req.filter ?? '').matchAll(/\w+ (ge|lt) ([^\s)]+)/g)) {
        const at = firstFrom(table.ms, Date.parse(literal as string));
        if (op === 'ge') lo = Math.max(lo, at);
        else hi = Math.min(hi, at);
      }
      const from = lo + (opts.ignoreSkip ? 0 : (req.skip ?? 0));
      return { rows: table.rows.slice(from, Math.min(hi, from + (req.top ?? hi))).map((r) => ({ ...r })), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

function recordingIngestor() {
  const seen: Partial<Record<DatasetName, Row[]>> = {};
  const ingestor = {
    ingest: async (dataset: DatasetName, rows: Row[]) => {
      (seen[dataset] ??= []).push(...rows);
      return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  /** Distinct rows of `dataset` read, by their `Id`. */
  const distinct = (dataset: DatasetName) => new Set((seen[dataset] ?? []).map((r) => r.Id)).size;
  return { ingestor, distinct };
}

function harness(tables: Record<string, { field: string | null; rows: Row[] }>, opts: { ignoreSkip?: boolean } = {}) {
  const db = fakePool();
  const src = liveSource(tables, opts);
  const { ingestor, distinct } = recordingIngestor();
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, src.source);
  return { db, src, poller, distinct };
}

const iso = (ms: number) => new Date(ms).toISOString();

const unitSteps: DatasetMapping = { entity_set: 'UnitSteps', watermark_field: null, key: ['Id'], fields: { unit_id: 'Id', complete_ts: 'Done' } };
const mapping = {
  work_orders: { entity_set: 'WorkOrders', watermark_field: null, key: ['Job'], fields: { job_number: 'Job', modified_at: 'Modified' } },
  unit_steps: unitSteps,
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

/** A page size of 10: a pass of the window pull reads at most 10,000 rows. */
const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', backfill_days: 1, poll_page_size: 10, late_data_hours: 72 };

const steps = (count: number, stamp: (i: number) => number): Row[] => Array.from({ length: count }, (_, i) => ({ Id: `S-${i}`, Done: iso(stamp(i)) }));

describe('a backfill day of more rows than one pass reads', () => {
  /** With `backfill_days` 1 the day downloaded is 2025-10-10 (UTC). */
  const now = Date.parse('2025-10-11T12:00:00Z');
  const day = Date.parse('2025-10-10T00:00:00Z');

  async function runDay(rows: Row[]) {
    const h = harness({ WorkOrders: { field: 'Modified', rows: [] }, UnitSteps: { field: 'Done', rows } });
    const backfill = new Backfill(h.db.pool, log, h.poller, { recomputeHours: async () => ({}) as never } as never, async () => undefined);
    await backfill.ensureScheduled(settings);
    await backfill.requestNow();
    await backfill.tick(mapping, settings, now);
    return { ...h, progress: h.db.state.get('backfill')?.backfill_progress };
  }

  it('is read whole, a pass at a time from the timestamp the last one stopped at, and counted', async () => {
    // 25,000 unit steps 3 s apart: 2,500 pages, so three passes.
    const { src, distinct, progress, db } = await runDay(steps(25_000, (i) => day + i * 3_000));

    expect(distinct('unit_steps')).toBe(25_000);
    expect(progress).toMatchObject({ days_done: 1, error: null });
    expect(db.syncLog.find((e) => e.source === 'unit_steps:backfill')).toMatchObject({ status: 'ok' });
    const upTo = `(Done lt ${iso(day + 86_400_000)})`;
    expect(src.requests.filter((r) => r.entitySet === 'UnitSteps' && !r.skip).map((r) => r.filter)).toEqual([
      `(Done ge ${iso(day)}) and ${upTo}`,
      `(Done ge ${iso(day + 9_999 * 3_000)}) and ${upTo}`,
      `(Done ge ${iso(day + 19_998 * 3_000)}) and ${upTo}`,
    ]);
  });

  it('fails, and is not counted, when more rows than a pass reads have one timestamp', async () => {
    const bulk = day + 6 * 3_600_000;
    const { progress, db } = await runDay(steps(10_500, () => bulk));

    expect(progress).toMatchObject({ days_done: 0, status: 'running' });
    expect(progress?.error).toBe(
      `unit_steps: the window pull cannot get past Done ${iso(bulk)}: more rows have it than the page cap (1000 pages of 10) reads in one pass. Raise poll_page_size`,
    );
    expect(db.syncLog.find((e) => e.source === 'unit_steps:backfill')).toMatchObject({ status: 'error', rows: 20_000 });
  });
});

describe('the late-data re-pull over more rows than one pass reads', () => {
  const now = Date.parse('2025-10-11T12:00:00Z');
  const late = { ...mapping, work_orders: null } as unknown as MappingConfig;

  it('reads the whole late_data_hours window', async () => {
    // 25,000 unit steps 10 s apart over the last 72 hours (none in the regular poll's last 2 hours).
    const { poller, db, distinct } = harness({ UnitSteps: { field: 'Done', rows: steps(25_000, (i) => now - 72 * 3_600_000 + 5_000 + i * 10_000) } });

    expect((await poller.pollOnce(late, settings, now)).ok).toBe(true);

    expect(distinct('unit_steps')).toBe(25_000);
    expect(db.state.get('late_data')).toMatchObject({ last_error: null, consecutive_failures: 0 });
    expect(db.syncLog.find((e) => e.source === 'unit_steps:late')).toMatchObject({ status: 'ok' });
  });

  it('is recorded as failed when it cannot read on', async () => {
    const bulk = now - 24 * 3_600_000;
    const { poller, db } = harness({ UnitSteps: { field: 'Done', rows: steps(10_500, () => bulk) } });

    expect((await poller.pollOnce(late, settings, now)).ok).toBe(true);

    expect(db.state.get('late_data')).toMatchObject({ consecutive_failures: 1, last_error: expect.stringContaining('Raise poll_page_size') });
    expect(db.syncLog.find((e) => e.source === 'unit_steps:late')).toMatchObject({ status: 'error' });
  });
});

describe('a whole data source (no timestamp) of more rows than one pass reads', () => {
  const jobs: DatasetMapping = { entity_set: 'Jobs', watermark_field: null, key: ['Id'], fields: { job_number: 'Id' } };
  const table = Array.from({ length: 25_000 }, (_, i) => ({ Id: `J-${i}` }));
  const window = { from: Date.parse('2025-10-10T00:00:00Z'), to: null, logSource: 'work_orders:backfill' };

  it('is read whole, each pass from the row after the last one read', async () => {
    const { poller, src, distinct } = harness({ Jobs: { field: null, rows: table } });

    expect(await poller.pullWindow('work_orders', jobs, settings, window)).toMatchObject({ rows: 25_000 });

    expect(distinct('work_orders')).toBe(25_000);
    expect(src.requests.filter((r) => [0, 10_000, 20_000].includes(r.skip ?? 0)).map((r) => r.skip ?? 0)).toEqual([0, 10_000, 20_000]);
  });

  it('fails instead of reading on forever when the service ignores $skip', async () => {
    const { poller, src, db } = harness({ Jobs: { field: null, rows: table } }, { ignoreSkip: true });

    await expect(poller.pullWindow('work_orders', jobs, settings, window)).rejects.toThrow('the service ignores $skip');

    expect(src.requests).toHaveLength(1_001);
    expect(db.syncLog).toEqual([expect.objectContaining({ source: 'work_orders:backfill', status: 'error' })]);
  });
});
