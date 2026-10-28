import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

/**
 * unit_steps whose job is not in the database fetch that work order by job number: a job last
 * changed before the first-run lookback (or before the backfill range) is still running today.
 */

type Row = Record<string, unknown> & { at: number };

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** Just enough Postgres for the poller and the real Ingestor (see poller-first-run-jobs.test.ts). */
function fakeDb() {
  const state = new Map<string, string | null>();
  const operations = new Map<string, number>();
  const workOrders = new Map<string, string>();
  const unitSteps: { unit_id: string; job_number: string }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    const none = { rows: [] as unknown[], rowCount: 0 };
    if (sql.includes('FROM sync_state WHERE source')) {
      const source = params[0] as string;
      if (!state.has(source)) return none;
      const row = { source, watermark: state.get(source) ?? null, last_success_at: null, last_error: null, consecutive_failures: 0 };
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO sync_state')) {
      const source = params[0] as string;
      const watermark = (sql.includes('last_success_at') ? params[1] : params[3]) as string | null;
      state.set(source, watermark ?? state.get(source) ?? null);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operations.has(name)) operations.set(name, operations.size + 1);
      return none;
    }
    if (sql.startsWith('SELECT id, name FROM operations')) {
      const names = (params[0] as string[] | undefined) ?? [...operations.keys()];
      return { rows: names.filter((n) => operations.has(n)).map((n) => ({ id: operations.get(n), name: n })), rowCount: 1 };
    }
    if (sql.includes('information_schema.columns')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.startsWith('SELECT job_number, product_number FROM work_orders')) {
      const jobs = params[0] as string[];
      return { rows: jobs.filter((j) => workOrders.has(j)).map((j) => ({ job_number: j, product_number: workOrders.get(j) })), rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO work_orders')) {
      for (let i = 0; i < params.length; i += 8) workOrders.set(params[i] as string, params[i + 1] as string);
      return { rows: [], rowCount: params.length / 8 };
    }
    if (sql.startsWith('INSERT INTO unit_steps')) {
      const width = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').length;
      for (let i = 0; i < params.length; i += width) unitSteps.push({ unit_id: params[i] as string, job_number: params[i + 1] as string });
      return { rows: [], rowCount: params.length / width };
    }
    return none;
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as unknown as Pool, workOrders, unitSteps };
}

/**
 * FactoryLogix: rows exist from `at` on; `<field> ge|lt <ts>` and `<field> eq '<text>'` (any of
 * them, joined by `or`), ordered ascending, $top/$skip. `refuseEq`: answers a job lookup with an error.
 */
function flSource(tables: Record<string, Row[]>, clock: { now: number }, opts: { refuseEq?: boolean } = {}) {
  const requests: { filter: string; skip: number }[] = [];
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: (_set, field) => (field.endsWith('Date') ? 'Edm.DateTimeOffset' : 'Edm.String'),
    literal: (_set, _field, value) => {
      if (value.kind === 'timestamp') return new Date(value.ms).toISOString();
      if (value.kind === 'string') return `'${value.value.replace(/'/g, "''")}'`;
      throw new Error(`unexpected ${value.kind} literal`);
    },
    describe: () => '',
    fetchPage: async (req) => {
      const filter = req.filter ?? '';
      const skip = req.skip ?? 0;
      requests.push({ filter, skip });
      let rows = (tables[req.entitySet] ?? []).filter((r) => r.at <= clock.now);
      const eq = [...filter.matchAll(/(\w+) eq '([^']*)'/g)].map((m) => [m[1] as string, m[2] as string] as const);
      if (eq.length > 0) {
        if (opts.refuseEq) throw new Error('HTTP 400 Bad Request');
        rows = rows.filter((r) => eq.some(([field, value]) => String(r[field]) === value));
      }
      for (const m of filter.matchAll(/(\w+) (ge|lt) ([0-9T:.\-Z]+)/g)) {
        const [, field, op, literal] = m as unknown as [string, string, string, string];
        const bound = Date.parse(literal);
        rows = rows.filter((r) => (op === 'ge' ? Date.parse(String(r[field])) >= bound : Date.parse(String(r[field])) < bound));
      }
      const orderField = (req.orderBy ?? '').split(' ')[0] as string;
      if (orderField) rows.sort((a, b) => Date.parse(String(a[orderField])) - Date.parse(String(b[orderField])));
      return { rows: rows.slice(skip, skip + (req.top ?? rows.length)).map(({ at: _at, ...r }) => r), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

const workOrdersMapping = {
  entity_set: 'WorkOrders',
  watermark_field: 'ModifiedDate',
  key: ['WorkOrderNumber'],
  fields: { job_number: 'WorkOrderNumber', product_number: 'PartNumber', qty_released: 'QuantityReleased', modified_at: 'ModifiedDate' },
};

/** `productOnSteps`: UnitProcessHistory carries the part number; otherwise it comes from the work order. */
function mappingWith(productOnSteps: boolean): MappingConfig {
  return {
    work_orders: workOrdersMapping,
    unit_steps: {
      entity_set: 'UnitProcessHistory',
      watermark_field: 'CompletedDate',
      key: ['UnitSerial', 'WorkOrderNumber', 'OperationName', 'StartedDate'],
      fields: {
        unit_id: 'UnitSerial',
        job_number: 'WorkOrderNumber',
        product_number: productOnSteps ? 'PartNumber' : null,
        operation: 'OperationName',
        operator: 'OperatorName',
        start_ts: 'StartedDate',
        complete_ts: 'CompletedDate',
      },
    },
    defects: null,
    operators: null,
    routes: null,
    standards: null,
  } as unknown as MappingConfig;
}

const iso = (ms: number) => new Date(ms).toISOString();
const install = Date.parse('2026-10-28T09:00:00Z');
const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', backfill_days: 0 };

function workOrder(job: string, part: string, modified: number): Row {
  return { WorkOrderNumber: job, PartNumber: part, QuantityReleased: 500, ModifiedDate: iso(modified), at: modified };
}

/** One SMT step a minute per job from 07:00 until `until`. */
function stepsFor(jobs: Record<string, string>, until: number): Row[] {
  const steps: Row[] = [];
  for (let t = Date.parse('2026-10-28T07:00:00Z'); t < until; t += 60_000) {
    for (const [job, part] of Object.entries(jobs)) {
      steps.push({
        UnitSerial: `${job}-SN-${t}`,
        WorkOrderNumber: job,
        PartNumber: part,
        OperationName: 'SMT',
        OperatorName: 'alice',
        StartedDate: iso(t - 50_000),
        CompletedDate: iso(t),
        at: t,
      });
    }
  }
  return steps;
}

/** Install at 09:00, then poll every 90 s up to `until`. */
async function run(opts: { workOrders: Row[]; steps: Row[]; until: number; mapping?: MappingConfig; settings?: Settings; refuseEq?: boolean }) {
  const mapping = opts.mapping ?? mappingWith(false);
  const clock = { now: install };
  const fl = flSource({ WorkOrders: opts.workOrders, UnitProcessHistory: opts.steps }, clock, { refuseEq: opts.refuseEq });
  const db = fakeDb();
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, fl.source);
  for (; clock.now <= opts.until; clock.now += 90_000) {
    const outcome = await poller.pollOnce(mapping, opts.settings ?? settings, clock.now);
    expect(outcome.ok).toBe(true);
  }
  const counted = (job: string) => new Set(db.unitSteps.filter((s) => s.job_number === job).map((s) => s.unit_id)).size;
  /** The job lookups: requests by job number, not counting the request a short answer is followed by. */
  const lookups = fl.requests.filter((r) => r.filter.includes(' eq ') && r.skip === 0).map((r) => r.filter);
  return { db, requests: fl.requests, lookups, counted };
}

describe('unit steps of a job that is not in the database', () => {
  it('the first work_orders poll reaches back as far as the late-data re-pull reads unit steps', async () => {
    const { requests } = await run({ workOrders: [], steps: [], until: install });
    // 24 h (late_data_hours) and the 10 min overlap before 09:00.
    expect(requests[0]?.filter).toBe('ModifiedDate ge 2026-10-27T08:50:00.000Z');

    const without = await run({ workOrders: [], steps: [], until: install, settings: { ...settings, late_data_hours: 0 } });
    expect(without.requests[0]?.filter).toBe('ModifiedDate ge 2026-10-28T06:50:00.000Z');
  });

  it('fetches by job number a job last changed three days before setup, and counts its units', async () => {
    const until = Date.parse('2026-10-28T10:00:00Z');
    const { db, lookups, counted } = await run({
      workOrders: [workOrder('J-OLD', 'Z-1', Date.parse('2026-10-25T14:00:00Z')), workOrder('J-NEW', 'Z-2', install - 30 * 60_000)],
      steps: stepsFor({ 'J-OLD': 'Z-1', 'J-NEW': 'Z-2' }, until),
      until,
    });

    expect(db.workOrders.get('J-OLD')).toBe('Z-1');
    // One a minute from 07:00 (the late-data re-pull) to 10:00.
    expect(counted('J-OLD')).toBe(180);
    expect(counted('J-NEW')).toBe(180);
    // Asked for once: from then on it is in the database.
    expect(lookups).toEqual(["WorkOrderNumber eq 'J-OLD'"]);
  });

  it('brings in the work order of steps that carry their own product, for the job lists', async () => {
    const until = Date.parse('2026-10-28T09:30:00Z');
    const { db, counted } = await run({
      workOrders: [workOrder('J-OLD', 'Z-1', Date.parse('2026-10-25T14:00:00Z'))],
      steps: stepsFor({ 'J-OLD': 'Z-1' }, until),
      until,
      mapping: mappingWith(true),
    });

    expect(db.workOrders.get('J-OLD')).toBe('Z-1');
    expect(counted('J-OLD')).toBe(150);
  });

  it('asks for a job FactoryLogix does not have at most once an hour', async () => {
    const until = Date.parse('2026-10-28T10:30:00Z');
    const { lookups, counted } = await run({
      workOrders: [workOrder('J-NEW', 'Z-2', install - 30 * 60_000)],
      steps: stepsFor({ 'J-GHOST': 'Z-9', 'J-NEW': 'Z-2' }, until),
      until,
    });

    // 61 polls and two late-data re-pulls read J-GHOST's steps; it is asked for at 09:00 and 10:00.
    expect(lookups).toEqual(["WorkOrderNumber eq 'J-GHOST'", "WorkOrderNumber eq 'J-GHOST'"]);
    expect(counted('J-GHOST')).toBe(0);
    expect(counted('J-NEW')).toBe(210);
  });

  it('a lookup FactoryLogix refuses leaves the poll ok and the other jobs counted', async () => {
    const until = Date.parse('2026-10-28T09:30:00Z');
    const { counted } = await run({
      workOrders: [workOrder('J-OLD', 'Z-1', Date.parse('2026-10-25T14:00:00Z')), workOrder('J-NEW', 'Z-2', install - 30 * 60_000)],
      steps: stepsFor({ 'J-OLD': 'Z-1', 'J-NEW': 'Z-2' }, until),
      until,
      refuseEq: true,
    });

    expect(counted('J-OLD')).toBe(0);
    expect(counted('J-NEW')).toBe(150);
  });
});
