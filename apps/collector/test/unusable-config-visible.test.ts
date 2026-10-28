import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';

/**
 * Drives the real Collector loop (src/index.ts) for one iteration with every collaborator faked.
 * The FactoryLogix connection is saved but the collector cannot use it (the stored password does
 * not decrypt with this ENCRYPTION_KEY, e.g. after a restore or a key change). settings.ts reports
 * that as `connection_error`; the collector goes idle as "never configured".
 */
const h = vi.hoisted(() => ({
  db: [] as { sql: string; params: unknown[] }[],
  logs: [] as { level: string; obj: unknown; msg: unknown }[],
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  const record = (sql: string, params: unknown[] = []) => h.db.push({ sql, params });
  return {
    ...actual,
    createPool: () => ({ end: async () => undefined, query: async () => ({ rows: [], rowCount: 0 }) }),
    exec: async (_db: unknown, sql: string, params?: unknown[]) => (record(sql, params), 1),
    q: async (_db: unknown, sql: string, params?: unknown[]) => (record(sql, params), []),
    q1: async (_db: unknown, sql: string, params?: unknown[]) => (record(sql, params), null),
    notify: async (_db: unknown, channel: string, payload: unknown) => void record(`NOTIFY ${channel}`, [JSON.stringify(payload)]),
  };
});

vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.js')>();
  const at = (level: string) => (obj: unknown, msg?: unknown) => void h.logs.push({ level, obj, msg });
  return { ...actual, createLogger: () => ({ info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') }) };
});

vi.mock('../src/settings.js', () => ({
  loadConfig: async () => ({
    settings: { ...DEFAULT_SETTINGS, plant_timezone: 'America/New_York' },
    mapping: {},
    connection: null,
    connection_error: 'could not decrypt the FactoryLogix password (check ENCRYPTION_KEY): bad auth tag [cfg-9921]',
    mapping_error: null,
  }),
}));

vi.mock('../src/control.js', () => ({
  ControlListener: class {
    onCommand: (() => void) | null = null;
    async start() {}
    take() {
      return [];
    }
    get pending() {
      return 0;
    }
    async stop() {}
  },
}));

vi.mock('../src/ingest/operations.js', () => ({ OperationCache: class { clear() {} async preload() {} } }));
vi.mock('../src/engine/recompute.js', () => ({ Recomputer: class {} }));
vi.mock('../src/engine/standards.js', () => ({ StandardsRecomputer: class {} }));

afterAll(() => {
  process.emit('SIGTERM');
});

describe('a saved FactoryLogix connection the collector cannot use', () => {
  it('shows the reason in the database (collector_state.last_error), not only in the collector log', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('DATABASE_URL', 'postgres://fld:fld@db.invalid:5432/fld');
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('../src/index.js');
    // While unconfigured the loop writes its heartbeat/status row, forced, on every pass.
    await vi.waitFor(() => expect(h.db.some((c) => c.sql.includes('UPDATE collector_state SET'))).toBe(true), { timeout: 5_000 });

    // The reason is logged ...
    expect(h.logs.some((l) => l.level === 'warn' && JSON.stringify(l.obj).includes('cfg-9921'))).toBe(true);

    // ... but the row the API serves as /api/health/sync (status "never", last_error NULL) does not
    // carry it, so Admin > Sync only says the collector has "never" polled.
    const persisted = h.db.filter((c) => c.params.some((p) => typeof p === 'string' && p.includes('cfg-9921')));
    expect(persisted).not.toHaveLength(0);
  });
});
