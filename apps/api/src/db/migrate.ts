/**
 * Migration runner. On start we ensure `schema_migrations` exists and apply every
 * `db/migrations/*.sql` (sorted by file name) that has not been applied yet, each file as a single
 * multi-statement query.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

export interface MigrationLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const LOCK_ID = 815_243_001;

/** Locate db/migrations: MIGRATIONS_DIR wins, then the repo layout, then the Docker image layout. */
export function resolveMigrationsDir(explicit?: string | null): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    // apps/api/{src,dist}/db -> repo root
    path.resolve(here, '..', '..', '..', '..', 'db', 'migrations'),
    // /app/apps/api/dist/db -> /app/db/migrations
    path.resolve(here, '..', '..', '..', '..', '..', 'db', 'migrations'),
    '/app/db/migrations',
    path.resolve(process.cwd(), 'db', 'migrations'),
    path.resolve(process.cwd(), '..', '..', 'db', 'migrations'),
  ].filter((c): c is string => Boolean(c));

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.toLowerCase().endsWith('.sql')).sort((a, b) => a.localeCompare(b));
}

/** What the runner needs from a pool: one dedicated connection. */
export interface MigrationPool {
  connect(): Promise<Db & { release(err?: Error | boolean): void }>;
}

/**
 * Session advisory locks belong to a connection, so the lock, every migration and the unlock run
 * on one client taken from the pool (through the pool they could land on different connections
 * and the unlock would miss).
 *
 * That client runs without the pool's statement timeout (createPool): a migration over a large
 * table may need longer, and so may waiting for another instance's lock. RESET puts the timeout
 * back before the client returns to the pool.
 */
export async function runMigrations(pool: MigrationPool, dir: string, log: MigrationLogger): Promise<string[]> {
  const db = await pool.connect();
  let broken: Error | undefined;
  try {
    await db.query('SET statement_timeout = 0');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await db.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    const applied: string[] = [];
    try {
      const files = await listMigrationFiles(dir);
      const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
      const done = new Set(rows.map((r) => r.name));

      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(path.join(dir, file), 'utf8');
        log.info(`applying migration ${file}`);
        await db.query(sql);
        await db.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
        applied.push(file);
      }
    } finally {
      try {
        await db.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
      } catch (err) {
        // Could not unlock: destroy the connection instead of returning it to the pool, which
        // also releases the lock.
        broken = err instanceof Error ? err : new Error(String(err));
      }
    }
    return applied;
  } finally {
    if (!broken) {
      try {
        await db.query('RESET statement_timeout');
      } catch (err) {
        // Could not reset: destroy the connection rather than pool one without a timeout.
        broken = err instanceof Error ? err : new Error(String(err));
      }
    }
    db.release(broken);
  }
}

/** Convenience wrapper used at boot: resolves the directory and applies pending migrations. */
export async function migrate(pool: MigrationPool, explicitDir: string | null, log: MigrationLogger): Promise<string[]> {
  const dir = resolveMigrationsDir(explicitDir);
  if (!dir) {
    log.warn('no db/migrations directory found (set MIGRATIONS_DIR); skipping migrations');
    return [];
  }
  log.info(`migrations directory: ${dir}`);
  const applied = await runMigrations(pool, dir, log);
  log.info(applied.length > 0 ? `applied ${applied.length} migration(s)` : 'database schema up to date');
  return applied;
}
