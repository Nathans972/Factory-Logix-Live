import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { AppEnv } from '../env.js';

const { Pool: PgPool, types } = pg;

// numeric -> number (all our numerics are small), int8 -> number (counts).
types.setTypeParser(1700, (v: string | null) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v)));

/**
 * Minimal query surface shared by `Pool` and `PoolClient` so repositories work inside or
 * outside a transaction.
 */
export interface Db {
  query<R extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<R>>;
}

export function createPool(env: Pick<AppEnv, 'databaseUrl'>): Pool {
  return new PgPool({
    connectionString: env.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'fld-api',
  });
}

/** Run `fn` inside a transaction on a dedicated client. */
export async function withTransaction<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Postgres unique-violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
