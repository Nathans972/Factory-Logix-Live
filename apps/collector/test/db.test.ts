import { describe, expect, it } from 'vitest';
import { BATCH_SIZE, bulkUpsert, chunk, createPool, toMs, type Queryable } from '../src/db.js';
import { parseControlPayload } from '../src/control.js';

function fakeDb(): { db: Queryable; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: params.length };
    },
  } as unknown as Queryable;
  return { db, calls };
}

describe('bulkUpsert', () => {
  it('builds a multi-row INSERT ... ON CONFLICT DO UPDATE', async () => {
    const { db, calls } = fakeDb();
    await bulkUpsert(db, {
      table: 'operators',
      columns: ['operator_id', 'display_name'],
      rows: [
        ['jdoe', null],
        ['asmith', 'A Smith'],
      ],
      conflict: ['operator_id'],
      update: ['display_name'],
      updateExpr: { display_name: 'COALESCE(EXCLUDED.display_name, operators.display_name)' },
      extraSet: ['last_seen_at = now()'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(
      'INSERT INTO operators (operator_id, display_name) VALUES ($1, $2), ($3, $4)' +
        ' ON CONFLICT (operator_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, operators.display_name), last_seen_at = now()',
    );
    expect(calls[0]!.params).toEqual(['jdoe', null, 'asmith', 'A Smith']);
  });

  it('falls back to DO NOTHING when nothing is updated', async () => {
    const { db, calls } = fakeDb();
    await bulkUpsert(db, { table: 't', columns: ['a'], rows: [[1]], conflict: ['a'], update: [] });
    expect(calls[0]!.sql).toContain('ON CONFLICT (a) DO NOTHING');
  });

  it('de-duplicates rows that collide on the conflict target (last one wins)', async () => {
    const { db, calls } = fakeDb();
    const start = new Date('2025-01-01T00:00:00Z');
    await bulkUpsert(db, {
      table: 'unit_steps',
      columns: ['natural_key', 'start_ts', 'result'],
      rows: [
        ['k1', start, 'pass'],
        ['k1', start, 'fail'],
        ['k2', start, 'pass'],
      ],
      conflict: ['natural_key', 'start_ts'],
      update: ['result'],
    });
    expect(calls[0]!.params).toEqual(['k1', start, 'fail', 'k2', start, 'pass']);
  });

  it('splits large sets into statements of at most 500 rows', async () => {
    const { db, calls } = fakeDb();
    const rows = Array.from({ length: 1120 }, (_, i) => [`k${i}`]);
    await bulkUpsert(db, { table: 't', columns: ['a'], rows, conflict: [] });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.params).toHaveLength(BATCH_SIZE);
    expect(calls[2]!.params).toHaveLength(120);
  });

  it('does nothing for an empty set', async () => {
    const { db, calls } = fakeDb();
    await bulkUpsert(db, { table: 't', columns: ['a'], rows: [], conflict: ['a'], update: ['a'] });
    expect(calls).toHaveLength(0);
  });
});

describe('createPool', () => {
  it('listens for idle-client errors so a database restart does not crash the collector', async () => {
    const warnings: string[] = [];
    const pool = createPool('postgres://localhost:1/none', { warn: (_obj, msg) => warnings.push(msg) });
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', new Error('terminating connection due to administrator command'), {} as never);
    expect(warnings).toEqual(['idle database connection lost']);
    await pool.end();
  });
});

describe('helpers', () => {
  it('chunks and converts timestamps', () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 2)).toEqual([]);
    expect(toMs(new Date('2025-01-01T00:00:00Z'))).toBe(Date.parse('2025-01-01T00:00:00Z'));
    expect(toMs(null)).toBeNull();
  });
});

describe('control commands', () => {
  it('parses the documented payloads', () => {
    expect(parseControlPayload('{"cmd":"restart"}')).toEqual({ cmd: 'restart' });
    expect(parseControlPayload('{"cmd":"backfill_now"}')).toEqual({ cmd: 'backfill_now' });
    expect(parseControlPayload('{"cmd":"recompute_standards","product_number":"Z-1"}')).toEqual({
      cmd: 'recompute_standards',
      product_number: 'Z-1',
    });
    expect(parseControlPayload('{"cmd":"recompute_standards"}')).toEqual({ cmd: 'recompute_standards', product_number: null });
    expect(parseControlPayload('{"cmd":"recompute_cells","from_utc":1,"to_utc":2}')).toEqual({
      cmd: 'recompute_cells',
      from_utc: 1,
      to_utc: 2,
    });
  });

  it('rejects unknown or malformed payloads', () => {
    expect(parseControlPayload('{"cmd":"drop_everything"}')).toBeNull();
    expect(parseControlPayload('not json')).toBeNull();
    expect(parseControlPayload(undefined)).toBeNull();
    expect(parseControlPayload('{"cmd":"recompute_cells","from_utc":5,"to_utc":5}')).toBeNull();
  });
});
