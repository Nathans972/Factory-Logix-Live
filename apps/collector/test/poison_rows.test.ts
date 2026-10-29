import { describe, expect, it } from 'vitest';
import { EXAMPLE_MAPPING } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

const INT4_MAX = 2_147_483_647;

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Transactional in-memory stand-in for the tables the ingest writes. It refuses what Postgres refuses:
 * a NUL byte in a text parameter (22021), a \u0000 escape in a jsonb document (22P05) and an integer
 * outside int4 (22003). Writes inside BEGIN..COMMIT only count once committed.
 */
function fakePool() {
  const committed = { workOrders: [] as unknown[][], unitSteps: [] as unknown[][] };
  const operationIds = new Map<string, number>();

  const apply = (sql: string, params: unknown[], later: (fn: () => void) => void) => {
    for (const p of params) {
      if (typeof p === 'string' && p.includes('\u0000')) throw pgError('invalid byte sequence for encoding "UTF8": 0x00', '22021');
    }
    if (sql.startsWith('INSERT INTO raw_events')) {
      for (const p of params) {
        if (typeof p === 'string' && p.includes('\\u0000')) throw pgError('unsupported Unicode escape sequence', '22P05');
      }
    }
    if (sql.startsWith('INSERT INTO work_orders')) {
      // job_number, product_number, product_name, qty_released, qty_complete, status, fl_created_at, fl_modified_at
      for (let i = 0; i < params.length; i += 8) {
        for (const qty of [params[i + 3], params[i + 4]]) {
          if (typeof qty === 'number' && Math.abs(qty) > INT4_MAX) throw pgError(`value "${qty}" is out of range for type integer`, '22003');
        }
        const row = params.slice(i, i + 8);
        later(() => committed.workOrders.push(row));
      }
      return { rows: [], rowCount: params.length / 8 };
    }
    if (sql.startsWith('INSERT INTO unit_steps')) {
      for (let i = 0; i < params.length; i += 12) {
        const row = params.slice(i, i + 12);
        later(() => committed.unitSteps.push(row));
      }
      return { rows: [], rowCount: params.length / 12 };
    }
    if (sql.includes('information_schema.columns')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operationIds.has(name)) operationIds.set(name, operationIds.size + 1);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT id, name FROM operations WHERE')) {
      const rows = (params[0] as string[]).map((name) => ({ id: operationIds.get(name), name }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO raw_event_hashes')) {
      // every key is new: RETURNING hands them all back
      const rows: { source: string; natural_key: string }[] = [];
      for (let i = 0; i < params.length; i += 3) rows.push({ source: params[i] as string, natural_key: params[i + 1] as string });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const client = () => {
    let pending: (() => void)[] | null = null;
    const later = (fn: () => void) => (pending ? pending.push(fn) : fn());
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql === 'BEGIN') {
          pending = [];
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'COMMIT') {
          for (const fn of pending ?? []) fn();
          pending = null;
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'ROLLBACK') {
          pending = null;
          return { rows: [], rowCount: 0 };
        }
        return apply(sql, params, later);
      },
      release: () => undefined,
    };
  };
  const autocommit = client();
  const pool = { query: autocommit.query, connect: async () => client() } as unknown as Pool;
  return { pool, committed };
}

function ingestor(pool: Pool) {
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'America/New_York' });
  return new Ingestor({ pool, log, operations: new OperationCache(pool), timestamps }, EXAMPLE_MAPPING);
}

const workOrder = (job: string, qty: number) => ({
  WorkOrderNumber: job,
  PartNumber: 'P-1',
  PartDescription: 'Widget',
  QuantityReleased: qty,
  QuantityComplete: 0,
  Status: 'Released',
  CreatedDate: '2026-03-09T12:00:00Z',
  ModifiedDate: '2026-03-10T12:00:00Z',
});

const step = (unit: string, operator: string) => ({
  UnitSerial: unit,
  WorkOrderNumber: 'J-1',
  PartNumber: 'P-1',
  OperationName: 'Weld',
  OperationSequence: 1,
  OperatorName: operator,
  StartedDate: '2026-03-10T12:00:00Z',
  CompletedDate: '2026-03-10T12:01:00Z',
  Result: 'Pass',
});

describe('one value the database rejects must not cost the whole page of rows', () => {
  it('control: a clean page of work orders and unit steps is stored', async () => {
    const { pool, committed } = fakePool();
    await ingestor(pool).ingest('work_orders', [workOrder('J-1', 100), workOrder('J-3', 250)]);
    await ingestor(pool).ingest('unit_steps', [step('U-1', 'jdoe'), step('U-3', 'bjones')]);

    expect(committed.workOrders.map((r) => r[0])).toEqual(['J-1', 'J-3']);
    expect(committed.unitSteps.map((r) => r[0])).toEqual(['U-1', 'U-3']);
  });

  it('a work order with an "unlimited" quantity above the int4 range does not stop the other work orders', async () => {
    const { pool, committed } = fakePool();
    const rows = [workOrder('J-1', 100), workOrder('J-2', 9_999_999_999), workOrder('J-3', 250)];

    await expect(ingestor(pool).ingest('work_orders', rows)).resolves.toBeDefined();

    expect(committed.workOrders.map((r) => r[0])).toEqual(expect.arrayContaining(['J-1', 'J-3']));
  });

  it('a unit step whose operator id carries a NUL byte does not stop the other steps', async () => {
    const { pool, committed } = fakePool();
    const rows = [step('U-1', 'jdoe'), step('U-2', 'asmith\u0000'), step('U-3', 'bjones')];

    await expect(ingestor(pool).ingest('unit_steps', rows)).resolves.toBeDefined();

    expect(committed.unitSteps.map((r) => r[0])).toEqual(expect.arrayContaining(['U-1', 'U-3']));
  });
});
