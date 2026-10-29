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
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface PoolWarnLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Postgres cancels any api statement still running after this (SQLSTATE 57014). A request keeps its
 * connection until its statement ends, even after the browser has given up on it, so without a
 * limit a few slow reads (all jobs over years of history) could hold all 10 and leave TVs, logins
 * and the health check waiting. Pages and TV refreshes normally need a fraction of that.
 */
const STATEMENT_TIMEOUT_MS = 15_000;

export function createPool(env: Pick<AppEnv, 'databaseUrl'>, log?: PoolWarnLogger): Pool {
  const pool = new PgPool({
    connectionString: env.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Sent when each connection starts, so it is the session default: RESET returns to it after a
    // SET (runMigrations lifts it for its own connection).
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'fld-api',
  });
  // An idle client dying (e.g. the database restarting) emits 'error' on the pool; without a
  // listener Node treats it as unhandled and the process exits. The pool drops that client and
  // the next query opens a fresh one, so a warning is all that is needed.
  pool.on('error', (err) => {
    if (log) log.warn({ err: err.message }, 'idle database connection lost');
    else console.warn(`idle database connection lost: ${err.message}`);
  });
  return pool;
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

/**
 * Startup: wait until the database answers. Every failed attempt is logged with its reason, so a
 * wrong password or host shows up in the log instead of looking like a database still starting.
 */
export async function waitForDb(db: Db, log: PoolWarnLogger, attempts = 30, delayMs = 2000): Promise<void> {
  let reason = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      // A refused connection to "localhost" (both ::1 and 127.0.0.1) has a code but no message.
      reason = err instanceof Error ? err.message || (err as NodeJS.ErrnoException).code || err.name : String(err);
    }
    log.warn({ err: reason }, `database not reachable yet (attempt ${attempt}/${attempts})`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`database is not reachable: ${reason}`);
}

/** Postgres unique-violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
