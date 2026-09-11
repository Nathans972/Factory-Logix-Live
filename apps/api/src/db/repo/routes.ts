/**
 * Product route resolution: mapped `product_routes` first, otherwise the distinct operations seen in
 * `unit_steps` ordered by min(operation_seq) (nulls last) then first appearance.
 */
import type { Db } from '../pool.js';

export async function getRoutesForProducts(db: Db, productNumbers: string[]): Promise<Record<string, string[]>> {
  const products = [...new Set(productNumbers.filter(Boolean))];
  const out: Record<string, string[]> = {};
  if (products.length === 0) return out;

  const mapped = await db.query<{ product_number: string; operation: string }>(
    `SELECT r.product_number, o.name AS operation
     FROM product_routes r JOIN operations o ON o.id = r.operation_id
     WHERE r.product_number = ANY($1::text[])
     ORDER BY r.product_number, r.sequence, o.name`,
    [products],
  );
  for (const row of mapped.rows) {
    (out[row.product_number] ??= []).push(row.operation);
  }

  const missing = products.filter((p) => !out[p] || out[p].length === 0);
  if (missing.length > 0) {
    const derived = await db.query<{ product_number: string; operation: string }>(
      `SELECT s.product_number, o.name AS operation
       FROM unit_steps s JOIN operations o ON o.id = s.operation_id
       WHERE s.product_number = ANY($1::text[])
       GROUP BY s.product_number, o.name
       ORDER BY s.product_number, (min(s.operation_seq) IS NULL), min(s.operation_seq), min(s.start_ts)`,
      [missing],
    );
    for (const row of derived.rows) {
      (out[row.product_number] ??= []).push(row.operation);
    }
  }

  for (const p of products) out[p] ??= [];
  return out;
}

export async function getRouteForProduct(db: Db, productNumber: string): Promise<string[]> {
  const routes = await getRoutesForProducts(db, [productNumber]);
  return routes[productNumber] ?? [];
}

/**
 * count(distinct unit_id) of completed unit_steps at the LAST operation of each job's route.
 * The engine only uses this when the work order has a null qty_complete, but it is always computed.
 */
export async function getDerivedQtyComplete(
  db: Db,
  jobs: { job_number: string; product_number: string }[],
  routes: Record<string, string[]>,
): Promise<Record<string, number>> {
  const jobNumbers: string[] = [];
  const operations: string[] = [];
  for (const job of jobs) {
    const route = routes[job.product_number];
    if (!route || route.length === 0) continue;
    jobNumbers.push(job.job_number);
    operations.push(route[route.length - 1]);
  }
  const out: Record<string, number> = {};
  if (jobNumbers.length === 0) return out;

  const { rows } = await db.query<{ job_number: string; units: number }>(
    `SELECT s.job_number, count(DISTINCT s.unit_id)::int AS units
     FROM unit_steps s
     JOIN operations o ON o.id = s.operation_id
     JOIN unnest($1::text[], $2::text[]) AS t(job_number, operation)
       ON t.job_number = s.job_number AND t.operation = o.name
     WHERE s.complete_ts IS NOT NULL
     GROUP BY s.job_number`,
    [jobNumbers, operations],
  );
  for (const job of jobNumbers) out[job] = 0;
  for (const r of rows) out[r.job_number] = Number(r.units) || 0;
  return out;
}

export async function getDerivedQtyCompleteForJob(
  db: Db,
  jobNumber: string,
  productNumber: string,
  routes: Record<string, string[]>,
): Promise<number | null> {
  const map = await getDerivedQtyComplete(db, [{ job_number: jobNumber, product_number: productNumber }], routes);
  return map[jobNumber] ?? null;
}
