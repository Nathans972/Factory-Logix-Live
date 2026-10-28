/**
 * A pull that stops at the page cap goes on where it stopped on the next poll (proof in
 * poller-bulk-update-stall.test.ts). Here: the resumed request, a row read before the stop that
 * changes in between (nothing stepped over), more than a page of them (read again from the
 * watermark, nothing lost), and a watermark changed in between (the stop point is dropped).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

type Row = { WorkOrderNumber: string; PartNumber: string; ModifiedDate: string };

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

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

/** `$filter=ModifiedDate ge <ts>` over a live table, ordered on ModifiedDate then the key, `$top`/`$skip`. */
function liveSource(table: Row[]) {
  const parsed = new Map<string, number>();
  const ms = (r: Row) => parsed.get(r.ModifiedDate) ?? (parsed.set(r.ModifiedDate, Date.parse(r.ModifiedDate)).get(r.ModifiedDate) as number);
  const requests: SourceRequest[] = [];
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => 'Edm.DateTimeOffset',
    literal: (_set, _field, value) => {
      if (value.kind !== 'timestamp') throw new Error('timestamp literal expected');
      return new Date(value.ms).toISOString();
    },
    describe: () => '',
    fetchPage: async (req) => {
      requests.push(req);
      const m = /^ModifiedDate ge (\S+)$/.exec(req.filter ?? '');
      if (!m) throw new Error(`unexpected filter ${req.filter}`);
      const since = Date.parse(m[1] as string);
      // Sorted in place: sorting the table again is cheap while few rows have changed.
      table.sort((a, b) => ms(a) - ms(b) || (a.WorkOrderNumber < b.WorkOrderNumber ? -1 : 1));
      let lo = 0;
      let hi = table.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ms(table[mid] as Row) < since) lo = mid + 1;
        else hi = mid;
      }
      const skip = req.skip ?? 0;
      return { rows: table.slice(lo + skip, lo + skip + (req.top ?? table.length)).map((r) => ({ ...r })), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

function recordingIngestor() {
  const seen: Row[] = [];
  const ingestor = {
    ingest: async (_dataset: DatasetName, rows: Row[]) => {
      seen.push(...rows);
      return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  return { ingestor, seen };
}

/** 50 rows a page: the page cap is 200 x 50 = 10,000 rows a poll. */
const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0, poll_page_size: 50 };

const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'ModifiedDate',
    key: ['WorkOrderNumber'],
    fields: { job_number: 'WorkOrderNumber', product_number: 'PartNumber', modified_at: 'ModifiedDate' },
  },
  unit_steps: null,
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const iso = (ms: number) => new Date(ms).toISOString();
const bulkAt = Date.parse('2026-10-28T02:00:00Z');

/** 12,000 jobs given one ModifiedDate by a bulk update; the stored watermark is just before it. */
function setup() {
  const table: Row[] = Array.from({ length: 12_000 }, (_, i) => ({
    WorkOrderNumber: `J-${String(i).padStart(5, '0')}`,
    PartNumber: 'Z-1',
    ModifiedDate: iso(bulkAt),
  }));
  const { source, requests } = liveSource(table);
  const db = fakePool();
  db.state.set('work_orders', iso(bulkAt - 120_000));
  const { ingestor, seen } = recordingIngestor();
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);
  const read = () => new Set(seen.map((r) => r.WorkOrderNumber));
  const job = (n: number) => table.find((r) => r.WorkOrderNumber === `J-${String(n).padStart(5, '0')}`) as Row;
  return { table, poller, db, requests, seen, read, job };
}

describe('a pull that stops at the page cap', () => {
  it('goes on with the same query from a page before where it stopped', async () => {
    const { table, poller, db, requests, read } = setup();

    expect((await poller.pollOnce(mapping, settings, bulkAt + 60_000)).ok).toBe(true);
    expect(requests).toHaveLength(200);
    expect(read().size).toBe(10_000);
    expect(db.state.get('work_orders')).toBe(iso(bulkAt));

    table.push({ WorkOrderNumber: 'J-NEW', PartNumber: 'Z-9', ModifiedDate: iso(bulkAt + 100_000) });
    expect((await poller.pollOnce(mapping, settings, bulkAt + 150_000)).ok).toBe(true);

    const resumed = requests.slice(200);
    expect(resumed[0]).toMatchObject({ filter: `ModifiedDate ge ${iso(bulkAt - 720_000)}`, skip: 9_950, top: 50 });
    // 2,000 rows left and J-NEW, after one page read again: 42 pages, the last one short.
    expect(resumed).toHaveLength(42);
    expect(read().size).toBe(12_001);
    expect(db.state.get('work_orders')).toBe(iso(bulkAt + 100_000));
  });

  it('a row read before the stop that changes before the next poll does not make it step over a row', async () => {
    const { poller, db, requests, seen, read, job } = setup();

    expect((await poller.pollOnce(mapping, settings, bulkAt + 60_000)).ok).toBe(true);
    // J-00100 moves to the end, so every row behind it moves up one: J-10000 is now where J-09999
    // was. This poll moves the watermark past the overlap, so a row it stepped over is never read.
    const changedAt = bulkAt + 20 * 60_000;
    job(100).ModifiedDate = iso(changedAt);
    expect((await poller.pollOnce(mapping, settings, changedAt + 60_000)).ok).toBe(true);

    expect(read().has('J-10000')).toBe(true);
    expect(read().size).toBe(12_000);
    expect(seen.filter((r) => r.WorkOrderNumber === 'J-00100').at(-1)?.ModifiedDate).toBe(iso(changedAt));
    expect(db.state.get('work_orders')).toBe(iso(changedAt));
    expect(requests[200]?.skip).toBe(9_950);
  });

  it('more than a page of them changing makes the pull read again from the watermark, and nothing is lost', async () => {
    const { poller, db, requests, read, job } = setup();

    expect((await poller.pollOnce(mapping, settings, bulkAt + 60_000)).ok).toBe(true);
    // 100 jobs of the part already read change: the last row read moves up past the resumed page.
    const changedAt = bulkAt + 20 * 60_000;
    for (let i = 0; i < 100; i += 1) job(i * 10).ModifiedDate = iso(changedAt);
    expect((await poller.pollOnce(mapping, settings, changedAt + 60_000)).ok).toBe(true);
    expect(db.state.get('work_orders')).toBe(iso(bulkAt));
    expect((await poller.pollOnce(mapping, settings, changedAt + 150_000)).ok).toBe(true);

    expect(read().size).toBe(12_000);
    expect(db.state.get('work_orders')).toBe(iso(changedAt));
    // Two pages looking for J-09999, then from the watermark again for the rest of the page cap.
    const poll2 = requests.slice(200, 400);
    expect(poll2.map((r) => r.skip ?? 0).slice(0, 3)).toEqual([9_950, 10_000, 0]);
    expect(poll2[2]?.filter).toBe(`ModifiedDate ge ${iso(bulkAt - 600_000)}`);
    expect(requests[400]?.skip).toBe(9_850);
  });

  it('is not gone on from once the stored watermark has changed', async () => {
    const { poller, db, requests } = setup();

    expect((await poller.pollOnce(mapping, settings, bulkAt + 60_000)).ok).toBe(true);
    // Someone sets the watermark back to read the night again.
    db.state.set('work_orders', iso(bulkAt - 3_600_000));
    expect((await poller.pollOnce(mapping, settings, bulkAt + 150_000)).ok).toBe(true);

    expect(requests[200]).toMatchObject({ filter: `ModifiedDate ge ${iso(bulkAt - 4_200_000)}` });
    expect(requests[200]?.skip ?? 0).toBe(0);
  });
});
