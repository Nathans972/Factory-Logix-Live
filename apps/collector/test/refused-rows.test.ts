/**
 * Red Team #1: a page of rows is written in one transaction, and Postgres refuses all of it for
 * one value it cannot store. Every poll read that page again from the same watermark and stopped
 * on it. Values the collector can make storable (a quantity or sequence beyond the int range) are
 * stored; a page Postgres still refuses is written again in halves, down to the rows it refuses on
 * their own, which are skipped. An error that is not about the rows still fails the page.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EXAMPLE_MAPPING, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

type Row = Record<string, unknown>;

const INT4_MAX = 2_147_483_647;

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Text no btree index entry can hold (more than 2704 bytes, and random, so Postgres cannot
 * compress it to fit): a scanner that dumped its whole buffer into the operator field.
 */
const SCANNER_DUMP = randomBytes(3000).toString('base64');

/**
 * Transactional in-memory stand-in for the tables the collector writes. It refuses what Postgres
 * refuses: NUL in text (22021), an integer outside int4 (22003; fl_standards.std_hr is numeric)
 * and text too long for an index entry (54000; any table but raw_events, whose payload is not
 * indexed). `fail` makes the next statement starting with a prefix throw a given error.
 */
function fakeDb() {
  let committed = new Map<string, Row[]>();
  const operations = new Map<string, number>();
  const syncState = new Map<string, string | null>();
  const syncLog: Row[] = [];
  const failures: { prefix: string; error: Error }[] = [];
  let transactions = 0;
  const ok = (rows: Row[] = []) => ({ rows, rowCount: rows.length });

  const run = (tables: Map<string, Row[]>, sql: string, params: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    const failure = failures.findIndex((f) => text.startsWith(f.prefix));
    if (failure >= 0) throw failures.splice(failure, 1)[0].error;
    if (text.startsWith('SELECT source, watermark')) {
      const source = params[0] as string;
      return ok(syncState.has(source) ? [{ source, watermark: syncState.get(source), consecutive_failures: 0, rows_last_poll: null, duration_ms_last_poll: null }] : []);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_success_at')) {
      syncState.set(params[0] as string, (params[1] as string | null) ?? syncState.get(params[0] as string) ?? null);
      return ok();
    }
    if (text.startsWith('INSERT INTO sync_state')) return ok();
    if (text.startsWith('INSERT INTO sync_log')) {
      syncLog.push({});
      return ok([{ id: syncLog.length }]);
    }
    if (text.startsWith('UPDATE sync_log')) {
      syncLog[(params[0] as number) - 1] = { status: params[2], error: params[3], ingested: params[4], skipped: params[5] };
      return ok();
    }
    for (const p of params) {
      if (typeof p === 'string' && p.includes('\u0000')) throw pgError('invalid byte sequence for encoding "UTF8": 0x00', '22021');
    }
    if (text.startsWith('SELECT 1 AS ok FROM information_schema.columns')) return ok([{ ok: 1 }]);
    if (text.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operations.has(name)) operations.set(name, operations.size + 1);
      return ok();
    }
    if (text.startsWith('SELECT id, name FROM operations')) return ok((params[0] as string[]).map((name) => ({ id: operations.get(name), name })));
    if (text.startsWith('SELECT job_number, product_number FROM work_orders')) {
      return ok((tables.get('work_orders') ?? []).filter((r) => (params[0] as string[]).includes(r.job_number as string)));
    }
    if (text.startsWith('SELECT product_number, operation_id, sequence FROM product_routes')) {
      return ok((tables.get('product_routes') ?? []).filter((r) => (params[0] as string[]).includes(r.product_number as string)));
    }
    // deleteMovedRows: no stored copy of these keys at another time.
    if (text.startsWith('DELETE FROM')) return ok();
    if (text.startsWith('INSERT INTO raw_event_hashes')) {
      const keys: Row[] = [];
      for (let i = 0; i < params.length; i += 3) keys.push({ source: params[i], natural_key: params[i + 1] });
      return ok(keys);
    }
    const insert = /^INSERT INTO (\w+) \(([^)]*)\) VALUES/.exec(text);
    if (!insert) throw new Error(`unexpected SQL: ${text}`);
    const [, table, list] = insert;
    const columns = list.split(', ');
    for (const p of params) {
      if (typeof p === 'number' && table !== 'fl_standards' && (p > INT4_MAX || p < -INT4_MAX - 1)) {
        throw pgError(`value "${p}" is out of range for type integer`, '22003');
      }
      if (typeof p === 'string' && table !== 'raw_events' && Buffer.byteLength(p) > 2704) {
        throw pgError(`index row size ${Buffer.byteLength(p) + 16} exceeds btree version 4 maximum 2704 for index "${table}_idx"`, '54000');
      }
    }
    const rows = tables.get(table) ?? [];
    for (let i = 0; i < params.length; i += columns.length) rows.push(Object.fromEntries(columns.map((c, j) => [c, params[i + j]])));
    tables.set(table, rows);
    return ok();
  };

  const pool = {
    query: async (sql: string, params: unknown[] = []) => run(committed, sql, params),
    connect: async () => {
      let working: Map<string, Row[]> | null = null;
      return {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql === 'BEGIN') {
            transactions += 1;
            working = new Map([...committed].map(([table, rows]) => [table, [...rows]]));
            return ok();
          }
          if (sql === 'COMMIT') {
            if (working) committed = working;
            working = null;
            return ok();
          }
          if (sql === 'ROLLBACK') {
            working = null;
            return ok();
          }
          return run(working ?? committed, sql, params);
        },
        release: () => undefined,
      };
    },
  } as unknown as Pool;

  return {
    pool,
    rows: (table: string) => committed.get(table) ?? [],
    syncState,
    syncLog,
    transactions: () => transactions,
    fail: (prefix: string, error: Error) => failures.push({ prefix, error }),
  };
}

function recordingLog() {
  const warnings: { obj: unknown; msg: string }[] = [];
  const log = {
    info: () => undefined,
    warn: (obj: unknown, msg: string) => warnings.push({ obj, msg }),
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  return { log, warnings };
}

function ingestor(pool: Pool, log: Logger, mapping: MappingConfig = EXAMPLE_MAPPING) {
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  return new Ingestor({ pool, log, operations: new OperationCache(pool), timestamps }, mapping);
}

const workOrder = (job: string, qty: number, extra: Row = {}) => ({
  WorkOrderNumber: job,
  PartNumber: 'P-1',
  PartDescription: 'Widget',
  QuantityReleased: qty,
  QuantityComplete: 0,
  Status: 'Released',
  CreatedDate: '2026-03-09T12:00:00Z',
  ModifiedDate: '2026-03-10T12:00:00Z',
  ...extra,
});

const step = (unit: string, operator: string, extra: Row = {}) => ({
  UnitSerial: unit,
  WorkOrderNumber: 'J-1',
  PartNumber: 'P-1',
  OperationName: 'Weld',
  OperationSequence: 1,
  OperatorName: operator,
  StartedDate: '2026-03-10T12:00:00Z',
  CompletedDate: '2026-03-10T12:01:00Z',
  Result: 'Pass',
  ...extra,
});

describe('a row Postgres refuses costs that row, not its page', () => {
  it('stores the steps around one whose operator id no index can hold, and counts it as skipped', async () => {
    const db = fakeDb();
    const { log, warnings } = recordingLog();
    const rows = [step('U-1', 'jdoe'), step('U-2', SCANNER_DUMP), step('U-3', 'bjones')];

    const outcome = await ingestor(db.pool, log).ingest('unit_steps', rows);

    expect(db.rows('unit_steps').map((r) => r.unit_id)).toEqual(['U-1', 'U-3']);
    expect(outcome).toMatchObject({ received: 3, ingested: 2, skipped: 1 });
    // The hours of the stored steps are recomputed; nothing of the refused one.
    expect(outcome.touched).toHaveLength(4);
    // The log names the refused row and what Postgres said.
    const warning = warnings.find((w) => w.msg.includes('refused'));
    expect(JSON.stringify(warning?.obj)).toContain('U-2|J-1|Weld|2026-03-10T12:00:00Z');
    expect(JSON.stringify(warning?.obj)).toContain('index row size');
  });

  it('finds one refused row in a large page with a few transactions, not one per row', async () => {
    const db = fakeDb();
    const rows = Array.from({ length: 64 }, (_, i) => step(`U-${i}`, i === 41 ? SCANNER_DUMP : 'jdoe'));

    const outcome = await ingestor(db.pool, recordingLog().log).ingest('unit_steps', rows);

    expect(outcome).toMatchObject({ received: 64, ingested: 63, skipped: 1 });
    expect(db.rows('unit_steps')).toHaveLength(63);
    // The whole page, then two halves at each of the six levels down to the refused row.
    expect(db.transactions()).toBeLessThanOrEqual(13);
  });

  it('skips a work order fetched for its unit steps that Postgres refuses, and stores the steps', async () => {
    const db = fakeDb();
    const { log } = recordingLog();
    const steps = [step('U-1', 'jdoe'), step('U-9', 'bjones', { WorkOrderNumber: 'J-9' })];
    // The product number is indexed (products' primary key); the steps carry their own.
    const fetchJobs = async () => [workOrder('J-9', 10, { PartNumber: SCANNER_DUMP })];

    const outcome = await ingestor(db.pool, log).ingest('unit_steps', steps, fetchJobs);

    expect(outcome).toMatchObject({ received: 2, ingested: 2, skipped: 0 });
    expect(db.rows('unit_steps').map((r) => r.unit_id)).toEqual(['U-1', 'U-9']);
    expect(db.rows('work_orders')).toEqual([]);
  });

  it.each([
    ['a connection the server ended', pgError('terminating connection due to administrator command', '57P01')],
    ['a deadlock', pgError('deadlock detected', '40P01')],
    ['an error with no SQLSTATE', new Error('Connection terminated unexpectedly')],
  ])('still fails the page on %s, without splitting it', async (_name, error) => {
    const db = fakeDb();
    db.fail('INSERT INTO unit_steps', error);
    const rows = [step('U-1', 'jdoe'), step('U-2', 'asmith'), step('U-3', 'bjones')];

    await expect(ingestor(db.pool, recordingLog().log).ingest('unit_steps', rows)).rejects.toBe(error);
    expect(db.rows('unit_steps')).toEqual([]);
    expect(db.transactions()).toBe(1);
  });
});

describe('numbers beyond the int range are stored at its end', () => {
  const withRoutes: MappingConfig = {
    ...EXAMPLE_MAPPING,
    routes: {
      entity_set: 'Routes',
      watermark_field: null,
      key: ['PartNumber', 'OperationName'],
      fields: { product_number: 'PartNumber', operation: 'OperationName', sequence: 'Sequence' },
    },
  };

  it('keeps a work order whose quantities are "no limit"', async () => {
    const db = fakeDb();
    const rows = [workOrder('J-1', 9_999_999_999, { QuantityComplete: 9_999_999_999 }), workOrder('J-2', -9_999_999_999)];

    const outcome = await ingestor(db.pool, recordingLog().log).ingest('work_orders', rows);

    expect(outcome).toMatchObject({ received: 2, ingested: 2, skipped: 0 });
    expect(db.rows('work_orders').map((r) => [r.job_number, r.qty_released, r.qty_complete])).toEqual([
      ['J-1', INT4_MAX, INT4_MAX],
      ['J-2', -INT4_MAX - 1, 0],
    ]);
  });

  it('keeps a unit step whose operation sequence is beyond int, and a route appended after it', async () => {
    const db = fakeDb();
    const ingest = ingestor(db.pool, recordingLog().log);

    const last = await ingest.ingest('unit_steps', [step('U-1', 'jdoe', { OperationName: 'Pack', OperationSequence: 9_999_999_999 })]);
    // A later operation with no sequence goes after the largest one the product's route has.
    const unsequenced = await ingest.ingest('unit_steps', [step('U-1', 'jdoe', { OperationName: 'Label', OperationSequence: null })]);

    expect(last).toMatchObject({ ingested: 1, skipped: 0 });
    expect(unsequenced).toMatchObject({ ingested: 1, skipped: 0 });
    expect(db.rows('unit_steps').map((r) => r.operation_seq)).toEqual([INT4_MAX, null]);
    expect(db.rows('product_routes').map((r) => r.sequence)).toEqual([INT4_MAX, INT4_MAX]);
  });

  it('keeps a mapped route whose sequence is beyond int', async () => {
    const db = fakeDb();

    const outcome = await ingestor(db.pool, recordingLog().log, withRoutes).ingest('routes', [
      { PartNumber: 'P-1', OperationName: 'Weld', Sequence: 10 },
      { PartNumber: 'P-1', OperationName: 'Pack', Sequence: 9_999_999_999 },
    ]);

    expect(outcome).toMatchObject({ ingested: 2, skipped: 0 });
    expect(db.rows('product_routes').map((r) => r.sequence)).toEqual([10, INT4_MAX]);
  });
});

describe('the poll gets past a row Postgres refuses', () => {
  const mapping = {
    work_orders: {
      entity_set: 'WorkOrders',
      watermark_field: 'Modified',
      key: ['Job'],
      fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty', modified_at: 'Modified' },
    },
    unit_steps: {
      entity_set: 'UnitSteps',
      watermark_field: 'Modified',
      key: ['Id'],
      fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done', modified_at: 'Modified' },
    },
    defects: {
      entity_set: 'Defects',
      watermark_field: 'Modified',
      key: ['DefectId'],
      fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', found_ts: 'Found', modified_at: 'Modified' },
    },
    operators: null,
    routes: null,
    standards: null,
  } as unknown as MappingConfig;

  function fakeSource(rows: Record<string, Row[]>) {
    const requests: SourceRequest[] = [];
    const source: Source = {
      kind: 'odata',
      init: async () => undefined,
      getMetadata: () => null,
      version: () => '4.0',
      edmType: () => null,
      literal: (_set, _field, value) => (value.kind === 'timestamp' ? new Date(value.ms).toISOString() : String(value)),
      describe: () => '',
      fetchPage: async (req) => {
        requests.push(req);
        return { rows: (req.skip ?? 0) === 0 ? (rows[req.entitySet] ?? []) : [], nextLink: null };
      },
      close: async () => undefined,
    };
    return { source, requests };
  }

  it('stores the rest of the page, moves the watermark past the refused row and polls the data sources after it', async () => {
    const db = fakeDb();
    const { log } = recordingLog();
    const src = fakeSource({
      WorkOrders: [
        { Job: 'J-1', Product: 'P-1', Qty: 10, Modified: '2025-03-04T11:00:00Z' },
        { Job: 'J-2', Product: 'P-2', Qty: 9_999_999_999, Modified: '2025-03-04T11:01:00Z' },
      ],
      UnitSteps: [
        { Id: 's1', Unit: 'U1', Job: 'J-1', Op: 'Solder', User: 'jdoe', Start: '2025-03-04T11:10:00Z', Done: '2025-03-04T11:12:00Z', Modified: '2025-03-04T11:12:00Z' },
        { Id: 's2', Unit: 'U2', Job: 'J-1', Op: 'Solder', User: SCANNER_DUMP, Start: '2025-03-04T11:11:00Z', Done: '2025-03-04T11:13:00Z', Modified: '2025-03-04T11:13:00Z' },
        { Id: 's3', Unit: 'U3', Job: 'J-2', Op: 'Solder', User: 'bjones', Start: '2025-03-04T11:12:00Z', Done: '2025-03-04T11:14:00Z', Modified: '2025-03-04T11:14:00Z' },
      ],
      Defects: [{ DefectId: 'd1', Unit: 'U1', Job: 'J-1', Op: 'Solder', Found: '2025-03-04T11:20:00Z', Modified: '2025-03-04T11:20:00Z' }],
    });
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const ingest = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
    const poller = new Poller({ pool: db.pool, log, ingestor: ingest, timestamps }, src.source);
    const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 };

    const outcome = await poller.pollOnce(mapping, settings, Date.parse('2025-03-04T12:00:00Z'));

    expect(outcome.error).toBeNull();
    expect(outcome.ok).toBe(true);
    expect(db.rows('work_orders').map((r) => r.job_number)).toEqual(['J-1', 'J-2']);
    expect(db.rows('unit_steps').map((r) => r.unit_id)).toEqual(['U1', 'U3']);
    expect(db.rows('defects').map((r) => r.unit_id)).toEqual(['U1']);
    expect(db.syncState.get('unit_steps')).toBe('2025-03-04T11:14:00.000Z');
    // Admin > Sync shows the pull as ok, with the refused row in its Skipped count.
    expect(db.syncLog).toContainEqual({ status: 'ok', error: null, ingested: 2, skipped: 1 });
  });
});
