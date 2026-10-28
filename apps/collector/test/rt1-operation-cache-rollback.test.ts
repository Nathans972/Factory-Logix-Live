/**
 * Red team (data integrity): OperationCache remembers an operation id that was inserted inside an
 * ingest transaction, and keeps it after that transaction rolls back.
 *
 * Ingestor.unitSteps resolves operation names inside its transaction (`resolveMany(names, client)`),
 * so a name seen for the first time is INSERTed and cached by the same transaction. If a later
 * statement in the transaction fails (a dropped connection, a deadlock, a statement timeout) the
 * operations row disappears with the rollback, but the cache still maps the name to that id. Every
 * following batch then writes unit_steps rows that reference an operation id which does not exist.
 *
 * The in-memory database below models only what this needs: BEGIN/ROLLBACK that undoes the
 * operations insert (a sequence is not rolled back, as in Postgres) and the
 * unit_steps.operation_id -> operations(id) foreign key from db/migrations/0001_init.sql.
 */
import { describe, expect, it } from 'vitest';
import type { MappingConfig } from '@fld/shared';
import type { Pool } from '../src/db.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

type Row = Record<string, unknown>;

function memoryDb() {
  let committed = new Map<string, number>();
  let working = new Map<string, number>();
  let inTx = false;
  let sequence = 0;
  const unitSteps: Row[] = [];
  const failures: { match: string; error: Error }[] = [];
  const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });

  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    const failure = failures.findIndex((f) => text.startsWith(f.match));
    if (failure >= 0) throw failures.splice(failure, 1)[0]!.error;

    if (text === 'BEGIN') {
      inTx = true;
      working = new Map(committed);
      return ok();
    }
    if (text === 'COMMIT') {
      committed = working;
      inTx = false;
      return ok();
    }
    if (text === 'ROLLBACK') {
      working = committed;
      inTx = false;
      return ok();
    }
    const visible = inTx ? working : committed;
    if (text.startsWith('INSERT INTO operations')) {
      const target = inTx ? working : committed;
      for (const name of params[0] as string[]) if (!target.has(name)) target.set(name, (sequence += 1));
      return ok();
    }
    if (text.startsWith('SELECT id, name FROM operations WHERE name = ANY')) {
      return ok((params[0] as string[]).filter((n) => visible.has(n)).map((name) => ({ id: visible.get(name), name })));
    }
    if (text.startsWith('SELECT 1 AS ok FROM information_schema.columns')) return ok();
    if (text.startsWith('SELECT job_number, product_number FROM work_orders')) return ok();
    if (text.startsWith('SELECT product_number, operation_id, sequence FROM product_routes')) return ok();
    if (text.startsWith('INSERT INTO raw_event_hashes')) {
      const changed: Row[] = [];
      for (let i = 0; i < params.length; i += 3) changed.push({ source: params[i], natural_key: params[i + 1] });
      return ok(changed);
    }
    if (text.startsWith('INSERT INTO unit_steps')) {
      // Columns: unit_id, job_number, product_number, operation_id, operator_id, start_ts, ... (11 per row).
      const ids = new Set(visible.values());
      for (let i = 3; i < params.length; i += 11) {
        if (!ids.has(params[i] as number)) {
          throw new Error('insert or update on table "unit_steps" violates foreign key constraint "unit_steps_operation_id_fkey"');
        }
        unitSteps.push({ operation_id: params[i], natural_key: params[i + 10] });
      }
      return ok([], params.length / 11);
    }
    if (/^INSERT INTO (products|operators|raw_events|product_routes) /.test(text)) return ok([], 1);
    throw new Error(`unexpected SQL: ${text}`);
  };

  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return {
    pool,
    unitSteps,
    operations: () => new Map(committed),
    /** The next statement starting with `match` fails once with `error`. */
    failOnce: (match: string, error: Error) => failures.push({ match, error }),
  };
}

const mapping = {
  work_orders: { entity_set: 'WorkOrders', watermark_field: 'Modified', key: ['Job'], fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty' } },
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

const page = [
  { StepId: 'S-1', Unit: 'U-1', Job: 'J-1', Product: 'P-1', Op: 'Weld', User: 'ann', Start: '2026-06-01T10:05:00Z', Done: '2026-06-01T10:20:00Z' },
  { StepId: 'S-2', Unit: 'U-2', Job: 'J-1', Product: 'P-1', Op: 'Weld', User: 'bob', Start: '2026-06-01T10:06:00Z', Done: '2026-06-01T10:21:00Z' },
];

function harness() {
  const db = memoryDb();
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const operations = new OperationCache(db.pool);
  const ingestor = new Ingestor({ pool: db.pool, log, operations, timestamps }, mapping);
  return { db, operations, ingestor };
}

describe('operation ids cached by a rolled-back ingest transaction', () => {
  it('the next batch after a failed first batch writes steps that point at an operation that exists', async () => {
    const { db, ingestor } = harness();

    // First poll after install: "Weld" is new. The database drops the connection while the unit_steps
    // batch is written, after the operations row was inserted in the same transaction.
    db.failOnce('INSERT INTO unit_steps', new Error('terminating connection due to administrator command'));
    await expect(ingestor.ingest('unit_steps', page)).rejects.toThrow('terminating connection');
    expect(db.operations().size).toBe(0); // rolled back with the transaction

    // The database is back. The next poll re-reads the same rows (the watermark never moved).
    await expect(ingestor.ingest('unit_steps', page)).resolves.toMatchObject({ ingested: 2, skipped: 0 });

    const known = new Set(db.operations().values());
    expect(db.unitSteps).toHaveLength(2);
    expect(db.unitSteps.every((s) => known.has(s.operation_id as number))).toBe(true);
  });

  it('control: the same retry works once the cache is cleared (what the restart command does)', async () => {
    const { db, operations, ingestor } = harness();
    db.failOnce('INSERT INTO unit_steps', new Error('terminating connection due to administrator command'));
    await expect(ingestor.ingest('unit_steps', page)).rejects.toThrow('terminating connection');

    operations.clear();
    await expect(ingestor.ingest('unit_steps', page)).resolves.toMatchObject({ ingested: 2, skipped: 0 });
    expect(db.unitSteps).toHaveLength(2);
  });
});
