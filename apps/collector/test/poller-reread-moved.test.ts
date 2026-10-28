/**
 * Rows that change while a pull pages through them (proof in poller-skip-shift.test.ts). Here: a
 * pull in which nothing changes makes the same requests as before; rows that keep changing stop
 * the pull with the watermark where they were, and the next poll reads the rest; the backfill's
 * work orders, open at the end, are read again the same way.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

type Row = Record<string, unknown>;

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

/**
 * A live table behind `$filter=<field> ge <ts>[ and <field> lt <ts>]&$orderby=<field> asc&$top&$skip`,
 * evaluated afresh for every request. `beforeRequest` changes rows between two page requests.
 */
function liveSource(table: Row[], beforeRequest: (req: SourceRequest) => void = () => undefined) {
  const requests: SourceRequest[] = [];
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
      beforeRequest(req);
      requests.push(req);
      const bounds = [...(req.filter ?? '').matchAll(/(\w+) (ge|lt) ([^\s)]+)/g)];
      if (bounds.length === 0) throw new Error(`unexpected filter ${req.filter}`);
      const field = bounds[0]?.[1] as string;
      let rows = table;
      for (const [, f, op, literal] of bounds) {
        const bound = Date.parse(literal as string);
        rows = rows.filter((r) => (op === 'ge' ? Date.parse(String(r[f as string])) >= bound : Date.parse(String(r[f as string])) < bound));
      }
      rows = [...rows].sort((a, b) => Date.parse(String(a[field])) - Date.parse(String(b[field])));
      const skip = req.skip ?? 0;
      return { rows: rows.slice(skip, skip + (req.top ?? rows.length)).map((r) => ({ ...r })), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

function recordingIngestor() {
  const seen: Record<string, Row[]> = {};
  const ingestor = {
    ingest: async (dataset: DatasetName, rows: Row[]) => {
      (seen[dataset] ??= []).push(...rows);
      return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  return { ingestor, seen };
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 };

const workOrders = {
  entity_set: 'WorkOrders',
  watermark_field: 'ModifiedDate',
  key: ['WorkOrderNumber'],
  fields: { job_number: 'WorkOrderNumber', product_number: 'PartNumber', modified_at: 'ModifiedDate' },
};
const mapping = { work_orders: workOrders, unit_steps: null, defects: null, operators: null, routes: null, standards: null } as unknown as MappingConfig;

const iso = (ms: number) => new Date(ms).toISOString();

function jobs(count: number, stamp: (i: number) => number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ WorkOrderNumber: `J-${String(i).padStart(4, '0')}`, PartNumber: 'Z-1', ModifiedDate: iso(stamp(i)) }));
}

function setup(table: Row[], beforeRequest?: (req: SourceRequest) => void) {
  const { source, requests } = liveSource(table, beforeRequest);
  const db = fakePool();
  const { ingestor, seen } = recordingIngestor();
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);
  const read = () => new Set((seen.work_orders ?? []).map((r) => r.WorkOrderNumber));
  return { poller, db, requests, read };
}

describe('rows that change while a pull pages through them', () => {
  const evening = Date.parse('2026-10-26T18:00:00Z');
  const resume = Date.parse('2026-10-27T06:00:00Z');

  it('a pull in which nothing changes makes the same requests as before', async () => {
    const { poller, db, requests, read } = setup(jobs(1200, (i) => evening + 60_000 + i * 30_000));
    db.state.set('work_orders', iso(evening));

    expect((await poller.pollOnce(mapping, settings, resume)).ok).toBe(true);

    expect(requests.map((r) => [r.filter, r.skip ?? 0])).toEqual([
      ['ModifiedDate ge 2026-10-26T17:50:00.000Z', 0],
      ['ModifiedDate ge 2026-10-26T17:50:00.000Z', 500],
      ['ModifiedDate ge 2026-10-26T17:50:00.000Z', 1000],
    ]);
    expect(read().size).toBe(1200);
    expect(db.state.get('work_orders')).toBe(iso(evening + 60_000 + 1199 * 30_000));
  });

  it('a row inserted ahead of the cursor brings the last row read back unchanged: no second pass', async () => {
    const table = jobs(1200, (i) => evening + 60_000 + i * 30_000);
    const { poller, db, requests, read } = setup(table, (req) => {
      // A late-committed job stamped among the first page's rows: every row behind it moves down one.
      if ((req.skip ?? 0) === 500) table.push({ WorkOrderNumber: 'J-LATE', PartNumber: 'Z-1', ModifiedDate: iso(evening + 120_000 + 15_000) });
    });
    db.state.set('work_orders', iso(evening));

    expect((await poller.pollOnce(mapping, settings, resume)).ok).toBe(true);

    expect(requests.map((r) => r.skip ?? 0)).toEqual([0, 500, 1000]);
    expect(read().size).toBe(1200);
  });

  it('rows that keep changing stop the pull with the watermark where they were; the next poll reads the rest', async () => {
    // One bulk action stamped 1,200 jobs with the same ModifiedDate. While the poll pages through
    // them, every later page request finds one more job of the first page changed again.
    const bulkAt = Date.parse('2026-10-27T05:00:00Z');
    const table = jobs(1200, () => bulkAt);
    const now = Date.parse('2026-10-27T05:30:00Z');
    let changing = true;
    let changes = 0;
    const { poller, db, requests, read } = setup(table, (req) => {
      if (!changing || (req.skip ?? 0) === 0) return;
      const job = table.find((r) => r.ModifiedDate === iso(bulkAt)) as Row;
      job.ModifiedDate = iso(Date.parse('2026-10-27T05:20:00Z') + changes * 1000);
      changes += 1;
    });
    db.state.set('work_orders', '2026-10-27T04:58:00.000Z');

    expect((await poller.pollOnce(mapping, settings, now)).ok).toBe(true);

    // Each pass stepped over jobs. The second pass read from the bulk action again and saw jobs
    // move once more, so the place to read again from did not move on: the pull stops there (no
    // third pass) and the watermark stays at the bulk action, not at the changed jobs' 05:20.
    expect(requests).toHaveLength(6);
    expect(requests[3]?.filter).toBe(`ModifiedDate ge ${iso(bulkAt)}`);
    expect(db.state.get('work_orders')).toBe(iso(bulkAt));

    changing = false;
    expect((await poller.pollOnce(mapping, settings, now + 90_000)).ok).toBe(true);
    expect(requests[6]?.filter).toBe('ModifiedDate ge 2026-10-27T04:50:00.000Z');
    expect(read().size).toBe(1200);
    expect(Date.parse(db.state.get('work_orders') ?? '')).toBeGreaterThanOrEqual(Date.parse('2026-10-27T05:20:00Z'));
  });

  it("the backfill's work orders, open at the end, are read again when a job changes during the pull", async () => {
    const firstDay = Date.parse('2026-09-27T00:00:00Z');
    const table = jobs(1200, (i) => firstDay + i * 3_600_000);
    let changed = false;
    const { poller, requests, read } = setup(table, (req) => {
      if (changed || (req.skip ?? 0) !== 500) return;
      (table.find((r) => r.WorkOrderNumber === 'J-0100') as Row).ModifiedDate = iso(resume + 5_000);
      changed = true;
    });

    const result = await poller.pullWindow('work_orders', workOrders as MappingConfig['work_orders'], settings, {
      from: firstDay,
      to: null,
      logSource: 'work_orders:backfill',
    });

    expect(changed).toBe(true);
    expect(requests.every((r) => !(r.filter ?? '').includes(' lt '))).toBe(true);
    expect(read().has('J-0500')).toBe(true);
    expect(read().size).toBe(1200);
    expect(result.truncated).toBe(false);
  });
});
