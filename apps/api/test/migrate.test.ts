import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationPool } from '../src/db/migrate.js';
import { FIRST_ADMIN_LOCK_ID, createFirstAdmin } from '../src/db/repo/users.js';

const quiet = { info: () => undefined, warn: () => undefined };

/** A pool that hands out numbered clients and records which client ran each statement. */
function fakePool(opts: { failOn?: string } = {}) {
  const log: { client: number; sql: string }[] = [];
  const released: { client: number; err: unknown }[] = [];
  let next = 0;
  const pool = {
    connect: async () => {
      const client = ++next;
      return {
        query: async (sql: string) => {
          log.push({ client, sql });
          if (opts.failOn && sql.includes(opts.failOn)) throw new Error(`boom: ${opts.failOn}`);
          if (sql.startsWith('SELECT name FROM schema_migrations')) return { rows: [{ name: '0001_a.sql' }], rowCount: 1 };
          if (sql.includes('RETURNING')) return { rows: [{ id: 1, username: 'admin', role: 'admin', active: true, created_at: new Date(0), last_login_at: null }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release: (err?: unknown) => {
          released.push({ client, err });
        },
      };
    },
  };
  return { pool, log, released };
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fld-migrations-'));
  await writeFile(path.join(dir, '0001_a.sql'), 'SELECT 1');
  await writeFile(path.join(dir, '0002_b.sql'), 'CREATE TABLE b (id int)');
  await writeFile(path.join(dir, '0003_c.sql'), 'CREATE TABLE c (id int)');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runMigrations', () => {
  it('runs the lock, every pending migration and the unlock on one client, then releases it', async () => {
    const { pool, log, released } = fakePool();
    const applied = await runMigrations(pool as unknown as MigrationPool, dir, quiet);
    expect(applied).toEqual(['0002_b.sql', '0003_c.sql']);
    expect(new Set(log.map((l) => l.client))).toEqual(new Set([1]));
    const sql = log.map((l) => l.sql);
    expect(sql.findIndex((s) => s.includes('pg_advisory_lock'))).toBeLessThan(sql.indexOf('CREATE TABLE b (id int)'));
    expect(sql.at(-1)).toContain('pg_advisory_unlock');
    expect(released).toEqual([{ client: 1, err: undefined }]);
  });

  it('unlocks and releases the client when a migration fails', async () => {
    const { pool, log, released } = fakePool({ failOn: 'CREATE TABLE c' });
    await expect(runMigrations(pool as unknown as MigrationPool, dir, quiet)).rejects.toThrow('boom');
    expect(log.at(-1)).toEqual({ client: 1, sql: 'SELECT pg_advisory_unlock($1)' });
    expect(released).toEqual([{ client: 1, err: undefined }]);
  });

  it('destroys the client instead of pooling it when the unlock fails', async () => {
    const { pool, released } = fakePool({ failOn: 'pg_advisory_unlock' });
    await runMigrations(pool as unknown as MigrationPool, dir, quiet);
    expect(released[0]?.err).toBeInstanceOf(Error);
  });
});

describe('createFirstAdmin', () => {
  it('inserts inside a transaction after a transaction-scoped advisory lock', async () => {
    const { pool, log, released } = fakePool();
    const user = await createFirstAdmin(pool as never, 'admin', 'hash');
    expect(user?.username).toBe('admin');
    expect(log.map((l) => l.sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1)',
      'INSERT INTO',
      'COMMIT',
    ]);
    expect(new Set(log.map((l) => l.client)).size).toBe(1);
    expect(released).toHaveLength(1);
    expect(FIRST_ADMIN_LOCK_ID).not.toBe(815_243_001);
  });
});
