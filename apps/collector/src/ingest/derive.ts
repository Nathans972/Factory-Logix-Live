/** Derived dimension tables: products, operators and product routes (spec 4.4, 6.1). */
import { bulkUpsert, q, toInt4, type Queryable } from '../db.js';

export interface ProductEntry {
  product_number: string;
  name: string | null;
}

export interface OperatorEntry {
  operator_id: string;
  display_name: string | null;
}

export interface RouteEntry {
  product_number: string;
  operation_id: number;
  /** null => unknown sequence; appended in first-seen order. */
  sequence: number | null;
}

export async function upsertProducts(db: Queryable, entries: ProductEntry[]): Promise<number> {
  const rows = new Map<string, [string, string | null]>();
  for (const e of entries) {
    if (!e.product_number) continue;
    const existing = rows.get(e.product_number);
    rows.set(e.product_number, [e.product_number, e.name ?? existing?.[1] ?? null]);
  }
  if (rows.size === 0) return 0;
  return bulkUpsert(db, {
    table: 'products',
    columns: ['product_number', 'name'],
    rows: [...rows.values()],
    conflict: ['product_number'],
    update: ['name'],
    updateExpr: { name: 'COALESCE(EXCLUDED.name, products.name)' },
    extraSet: ['last_seen_at = now()'],
  });
}

export async function upsertOperators(db: Queryable, entries: OperatorEntry[]): Promise<number> {
  const rows = new Map<string, [string, string | null]>();
  for (const e of entries) {
    if (!e.operator_id) continue;
    const existing = rows.get(e.operator_id);
    rows.set(e.operator_id, [e.operator_id, e.display_name ?? existing?.[1] ?? null]);
  }
  if (rows.size === 0) return 0;
  return bulkUpsert(db, {
    table: 'operators',
    columns: ['operator_id', 'display_name'],
    rows: [...rows.values()],
    conflict: ['operator_id'],
    update: ['display_name'],
    updateExpr: { display_name: 'COALESCE(EXCLUDED.display_name, operators.display_name)' },
    extraSet: ['last_seen_at = now()'],
  });
}

/** Routes that came from a mapped routes dataset win over anything derived. */
export async function upsertRoutesMapped(db: Queryable, entries: RouteEntry[]): Promise<number> {
  const rows = entries
    .filter((e) => e.product_number && e.sequence !== null)
    .map((e) => [e.product_number, e.operation_id, e.sequence, 'mapped']);
  if (rows.length === 0) return 0;
  return bulkUpsert(db, {
    table: 'product_routes',
    columns: ['product_number', 'operation_id', 'sequence', 'source'],
    rows,
    conflict: ['product_number', 'operation_id'],
    update: ['sequence', 'source'],
  });
}

/**
 * Derived routes: use the smallest operation_seq we have seen for a (product, operation);
 * operations without a sequence are appended after the current maximum, in first-seen order.
 * Never overwrites rows that came from a mapped routes dataset.
 */
export async function upsertRoutesDerived(db: Queryable, entries: RouteEntry[]): Promise<number> {
  const withSeq = entries.filter((e) => e.product_number && e.sequence !== null && Number.isFinite(e.sequence));
  const withoutSeq = entries.filter((e) => e.product_number && (e.sequence === null || !Number.isFinite(e.sequence)));
  let affected = 0;

  if (withSeq.length > 0) {
    affected += await bulkUpsert(db, {
      table: 'product_routes',
      columns: ['product_number', 'operation_id', 'sequence', 'source'],
      rows: withSeq.map((e) => [e.product_number, e.operation_id, toInt4(e.sequence as number), 'derived']),
      conflict: ['product_number', 'operation_id'],
      update: ['sequence'],
      updateExpr: { sequence: 'LEAST(EXCLUDED.sequence, product_routes.sequence)' },
      where: "product_routes.source <> 'mapped'",
    });
  }

  if (withoutSeq.length === 0) return affected;

  const products = [...new Set(withoutSeq.map((e) => e.product_number))];
  const existing = await q<{ product_number: string; operation_id: number; sequence: number }>(
    db,
    'SELECT product_number, operation_id, sequence FROM product_routes WHERE product_number = ANY($1::text[])',
    [products],
  );
  const known = new Set<string>();
  const maxSeq = new Map<string, number>();
  for (const row of existing) {
    known.add(`${row.product_number}\u0001${row.operation_id}`);
    maxSeq.set(row.product_number, Math.max(maxSeq.get(row.product_number) ?? 0, Number(row.sequence)));
  }

  const rows: unknown[][] = [];
  for (const entry of withoutSeq) {
    const key = `${entry.product_number}\u0001${entry.operation_id}`;
    if (known.has(key)) continue;
    known.add(key);
    // A route already at the top of the int range (2,147,483,647, a "last" sentinel) appends there too.
    const next = toInt4((maxSeq.get(entry.product_number) ?? 0) + 1);
    maxSeq.set(entry.product_number, next);
    rows.push([entry.product_number, entry.operation_id, next, 'derived']);
  }
  if (rows.length === 0) return affected;

  affected += await bulkUpsert(db, {
    table: 'product_routes',
    columns: ['product_number', 'operation_id', 'sequence', 'source'],
    rows,
    conflict: ['product_number', 'operation_id'],
    update: [],
  });
  return affected;
}
