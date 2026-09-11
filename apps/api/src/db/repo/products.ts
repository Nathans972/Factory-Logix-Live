import type { Product, ProductListItem } from '@fld/shared';
import type { Db } from '../pool.js';
import { toMs, toNumOr } from '../util.js';

type ProductRow = { product_number: string; name: string | null; first_seen_at: Date | null; last_seen_at: Date | null };

export function mapProduct(row: ProductRow): Product {
  return {
    product_number: row.product_number,
    name: row.name,
    first_seen_at: toMs(row.first_seen_at),
    last_seen_at: toMs(row.last_seen_at),
  };
}

export async function getProduct(db: Db, productNumber: string): Promise<Product | null> {
  const { rows } = await db.query<ProductRow>(
    'SELECT product_number, name, first_seen_at, last_seen_at FROM products WHERE product_number = $1',
    [productNumber],
  );
  return rows.length > 0 ? mapProduct(rows[0]) : null;
}

export async function getProductNames(db: Db, productNumbers: string[]): Promise<Record<string, string | null>> {
  if (productNumbers.length === 0) return {};
  const { rows } = await db.query<{ product_number: string; name: string | null }>(
    'SELECT product_number, name FROM products WHERE product_number = ANY($1::text[])',
    [productNumbers],
  );
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.product_number] = r.name;
  return out;
}

export async function listProducts(db: Db, q: string | null, limit = 500): Promise<ProductListItem[]> {
  const like = q ? `%${q}%` : null;
  const { rows } = await db.query<{
    product_number: string;
    name: string | null;
    route_ops: number;
    std_ops: number;
    standards_computed: number;
  }>(
    `SELECT p.product_number, p.name,
            COALESCE(r.n, 0)::int AS route_ops,
            COALESCE(s.n, 0)::int AS std_ops,
            COALESCE(s.c, 0)::int AS standards_computed
     FROM products p
     LEFT JOIN (SELECT product_number, count(*) AS n FROM product_routes GROUP BY 1) r
            ON r.product_number = p.product_number
     LEFT JOIN (SELECT product_number, count(*) AS n, count(computed_std_hr) AS c FROM standards GROUP BY 1) s
            ON s.product_number = p.product_number
     WHERE ($1::text IS NULL OR p.product_number ILIKE $1 OR p.name ILIKE $1)
     ORDER BY p.product_number
     LIMIT $2`,
    [like, limit],
  );
  return rows.map((r) => ({
    product_number: r.product_number,
    name: r.name,
    operations: Math.max(toNumOr(r.route_ops, 0), toNumOr(r.std_ops, 0)),
    standards_computed: toNumOr(r.standards_computed, 0),
  }));
}
