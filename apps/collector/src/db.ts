/** Postgres pool plus the small query helpers the collector needs. */
import pgPkg from 'pg';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const { Pool: PgPool, types } = pgPkg;

// numeric + bigint come back as strings by default; the collector wants plain numbers.
types.setTypeParser(1700, (v: string) => (v === null ? null : Number(v))); // numeric
types.setTypeParser(20, (v: string) => (v === null ? null : Number(v))); // int8

export type { Pool, PoolClient };
export type Queryable = Pool | PoolClient;

/** Max rows per multi-row INSERT statement (spec: batched upserts, <= 500 rows). */
export const BATCH_SIZE = 500;

export function createPool(connectionString: string): Pool {
  return new PgPool({
    connectionString,
    max: 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'fld-collector',
  });
}

export async function q<T extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(sql, params as never[]);
  return res.rows;
}

export async function q1<T extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(db, sql, params);
  return rows.length > 0 ? (rows[0] as T) : null;
}

export async function exec(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const res = await db.query(sql, params as never[]);
  return res.rowCount ?? 0;
}

export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw err;
    }
  });
}

export function chunk<T>(items: T[], size = BATCH_SIZE): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Postgres timestamptz (Date) -> UTC epoch ms. */
export function toMs(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function toDate(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface UpsertSpec {
  table: string;
  columns: string[];
  rows: unknown[][];
  /** Conflict target columns. Empty => plain INSERT. */
  conflict: string[];
  /** Columns updated from EXCLUDED on conflict. Empty => DO NOTHING. */
  update?: string[];
  /** Extra raw assignments appended to the SET clause, e.g. `updated_at = now()`. */
  extraSet?: string[];
  /** Raw SQL predicate for the DO UPDATE branch. */
  where?: string;
  /** Raw SQL expression overrides per updated column, e.g. { sequence: 'LEAST(EXCLUDED.sequence, t.sequence)' }. */
  updateExpr?: Record<string, string>;
}

function conflictKey(row: unknown[], indexes: number[]): string {
  return indexes
    .map((i) => {
      const v = row[i];
      if (v === null || v === undefined) return '\u0000';
      if (v instanceof Date) return String(v.getTime());
      return String(v);
    })
    .join('\u0001');
}

/**
 * Batched multi-row upsert. Rows that collide on the conflict target inside one statement are
 * de-duplicated (last one wins) because Postgres refuses to update the same row twice.
 */
export async function bulkUpsert(db: Queryable, spec: UpsertSpec): Promise<number> {
  if (spec.rows.length === 0) return 0;
  const { table, columns, conflict } = spec;
  const conflictIdx = conflict.map((c) => columns.indexOf(c)).filter((i) => i >= 0);

  let rows = spec.rows;
  if (conflictIdx.length === conflict.length && conflict.length > 0) {
    const seen = new Map<string, unknown[]>();
    for (const row of rows) seen.set(conflictKey(row, conflictIdx), row);
    rows = [...seen.values()];
  }

  const setParts: string[] = [];
  for (const col of spec.update ?? []) {
    setParts.push(`${col} = ${spec.updateExpr?.[col] ?? `EXCLUDED.${col}`}`);
  }
  for (const extra of spec.extraSet ?? []) setParts.push(extra);

  let onConflict = '';
  if (conflict.length > 0) {
    onConflict =
      setParts.length > 0
        ? ` ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${setParts.join(', ')}${spec.where ? ` WHERE ${spec.where}` : ''}`
        : ` ON CONFLICT (${conflict.join(', ')}) DO NOTHING`;
  }

  let affected = 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}${onConflict}`;
    affected += await exec(db, sql, params);
  }
  return affected;
}

/** NOTIFY with an arbitrary JSON payload (pg_notify avoids quoting problems). */
export async function notify(db: Queryable, channel: string, payload: unknown): Promise<void> {
  await exec(db, 'SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
}
