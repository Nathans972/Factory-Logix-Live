import { describe, expect, it } from 'vitest';
import type { Queryable } from '../src/db.js';
import { upsertOperators, upsertProducts, upsertRoutesDerived, upsertRoutesMapped } from '../src/ingest/derive.js';

interface Call {
  sql: string;
  params: unknown[];
}

/** Records every statement; SELECTs return `selectRows`, writes report one affected row per tuple. */
function fakeDb(selectRows: Record<string, unknown>[] = []): { db: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT')) return { rows: selectRows, rowCount: selectRows.length };
      const tuples = (sql.match(/\(\$\d+/g) ?? []).length;
      return { rows: [], rowCount: tuples };
    },
  } as unknown as Queryable;
  return { db, calls };
}

/** Splits a flat params array back into the inserted rows. */
function tuples(params: unknown[], width: number): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 0; i < params.length; i += width) out.push(params.slice(i, i + width));
  return out;
}

describe('upsertProducts', () => {
  it('skips blank product numbers and issues nothing when no rows remain', async () => {
    const { db, calls } = fakeDb();
    expect(await upsertProducts(db, [{ product_number: '', name: 'Ghost' }])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('dedupes by product number; a later null name does not erase an earlier one', async () => {
    const { db, calls } = fakeDb();
    const affected = await upsertProducts(db, [
      { product_number: 'P1', name: 'Widget' },
      { product_number: 'P1', name: null },
      { product_number: 'P2', name: null },
      { product_number: 'P2', name: 'Gadget' },
    ]);
    expect(affected).toBe(2);
    expect(calls).toHaveLength(1);
    expect(tuples(calls[0]!.params, 2)).toEqual([
      ['P1', 'Widget'],
      ['P2', 'Gadget'],
    ]);
    expect(calls[0]!.sql).toContain('name = COALESCE(EXCLUDED.name, products.name)');
    expect(calls[0]!.sql).toContain('last_seen_at = now()');
  });

  it('a later non-null name replaces an earlier one', async () => {
    const { db, calls } = fakeDb();
    await upsertProducts(db, [
      { product_number: 'P1', name: 'Old' },
      { product_number: 'P1', name: 'New' },
    ]);
    expect(calls[0]!.params).toEqual(['P1', 'New']);
  });
});

describe('upsertOperators', () => {
  it('dedupes by operator id and keeps the last known display name', async () => {
    const { db, calls } = fakeDb();
    const affected = await upsertOperators(db, [
      { operator_id: 'jdoe', display_name: 'J Doe' },
      { operator_id: '', display_name: 'Nobody' },
      { operator_id: 'jdoe', display_name: null },
      { operator_id: 'asmith', display_name: null },
    ]);
    expect(affected).toBe(2);
    expect(tuples(calls[0]!.params, 2)).toEqual([
      ['jdoe', 'J Doe'],
      ['asmith', null],
    ]);
    expect(calls[0]!.sql).toContain('display_name = COALESCE(EXCLUDED.display_name, operators.display_name)');
  });

  it('does nothing for an empty list', async () => {
    const { db, calls } = fakeDb();
    expect(await upsertOperators(db, [])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('upsertRoutesMapped', () => {
  it('writes only rows with a product and a sequence, tagged mapped, overwriting sequence and source', async () => {
    const { db, calls } = fakeDb();
    const affected = await upsertRoutesMapped(db, [
      { product_number: 'P1', operation_id: 10, sequence: 1 },
      { product_number: 'P1', operation_id: 20, sequence: null },
      { product_number: '', operation_id: 30, sequence: 3 },
      { product_number: 'P1', operation_id: 40, sequence: 2 },
    ]);
    expect(affected).toBe(2);
    expect(tuples(calls[0]!.params, 4)).toEqual([
      ['P1', 10, 1, 'mapped'],
      ['P1', 40, 2, 'mapped'],
    ]);
    expect(calls[0]!.sql).toContain(
      'ON CONFLICT (product_number, operation_id) DO UPDATE SET sequence = EXCLUDED.sequence, source = EXCLUDED.source',
    );
    expect(calls[0]!.sql).not.toContain('WHERE');
  });

  it('does nothing when no row has a sequence', async () => {
    const { db, calls } = fakeDb();
    expect(await upsertRoutesMapped(db, [{ product_number: 'P1', operation_id: 10, sequence: null }])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('upsertRoutesDerived', () => {
  it('upserts sequenced rows with LEAST and never touches mapped routes', async () => {
    const { db, calls } = fakeDb();
    const affected = await upsertRoutesDerived(db, [
      { product_number: 'P1', operation_id: 10, sequence: 2.9 },
      { product_number: 'P1', operation_id: 20, sequence: 5 },
    ]);
    expect(affected).toBe(2);
    expect(calls).toHaveLength(1);
    // Fractional sequences are truncated, not rounded.
    expect(tuples(calls[0]!.params, 4)).toEqual([
      ['P1', 10, 2, 'derived'],
      ['P1', 20, 5, 'derived'],
    ]);
    expect(calls[0]!.sql).toContain('DO UPDATE SET sequence = LEAST(EXCLUDED.sequence, product_routes.sequence)');
    expect(calls[0]!.sql).toContain("WHERE product_routes.source <> 'mapped'");
  });

  it('within one batch the last duplicate (product, operation) wins before the database applies LEAST', async () => {
    const { db, calls } = fakeDb();
    await upsertRoutesDerived(db, [
      { product_number: 'P1', operation_id: 10, sequence: 1 },
      { product_number: 'P1', operation_id: 10, sequence: 4 },
    ]);
    expect(calls[0]!.params).toEqual(['P1', 10, 4, 'derived']);
  });

  it('appends unsequenced operations after the current max, in first-seen order, skipping known ones', async () => {
    const { db, calls } = fakeDb([
      // pg may hand back numerics as strings; the code coerces with Number().
      { product_number: 'P1', operation_id: 10, sequence: '3' },
      { product_number: 'P1', operation_id: 20, sequence: 7 },
    ]);
    const affected = await upsertRoutesDerived(db, [
      { product_number: 'P1', operation_id: 30, sequence: null },
      { product_number: 'P1', operation_id: 10, sequence: null }, // already routed
      { product_number: 'P1', operation_id: 40, sequence: null },
      { product_number: 'P1', operation_id: 30, sequence: null }, // repeat in this batch
      { product_number: 'P2', operation_id: 10, sequence: null }, // product with no routes yet
    ]);
    expect(affected).toBe(3);
    expect(calls).toHaveLength(2);

    expect(calls[0]!.sql).toBe(
      'SELECT product_number, operation_id, sequence FROM product_routes WHERE product_number = ANY($1::text[])',
    );
    expect(calls[0]!.params).toEqual([['P1', 'P2']]);

    expect(tuples(calls[1]!.params, 4)).toEqual([
      ['P1', 30, 8, 'derived'],
      ['P1', 40, 9, 'derived'],
      ['P2', 10, 1, 'derived'],
    ]);
    // Appended rows never overwrite anything.
    expect(calls[1]!.sql).toContain('ON CONFLICT (product_number, operation_id) DO NOTHING');
  });

  it('treats non-finite sequences as unknown', async () => {
    const { db, calls } = fakeDb();
    await upsertRoutesDerived(db, [
      { product_number: 'P1', operation_id: 10, sequence: Number.NaN },
      { product_number: 'P1', operation_id: 20, sequence: Number.POSITIVE_INFINITY },
    ]);
    expect(calls[0]!.sql.startsWith('SELECT')).toBe(true);
    expect(tuples(calls[1]!.params, 4)).toEqual([
      ['P1', 10, 1, 'derived'],
      ['P1', 20, 2, 'derived'],
    ]);
  });

  it('skips the insert when every unsequenced operation is already routed', async () => {
    const { db, calls } = fakeDb([{ product_number: 'P1', operation_id: 10, sequence: 1 }]);
    const affected = await upsertRoutesDerived(db, [{ product_number: 'P1', operation_id: 10, sequence: null }]);
    expect(affected).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('ignores entries without a product number', async () => {
    const { db, calls } = fakeDb();
    expect(
      await upsertRoutesDerived(db, [
        { product_number: '', operation_id: 10, sequence: 1 },
        { product_number: '', operation_id: 20, sequence: null },
      ]),
    ).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
