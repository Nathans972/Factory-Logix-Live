import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';

/**
 * Drives the real Collector loop (src/index.ts) for one iteration with every collaborator faked,
 * and records everything it asks the database to store. A poll that ingests fine but whose hour
 * cell recompute throws must leave a trace the API can show; today it is only a log line.
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
    connection: { base_url: 'http://factorylogix.invalid', username: 'reader', password: 'secret' },
    connection_error: null,
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

vi.mock('../src/sources/ODataSource.js', () => ({
  ODataSource: class {
    async init() {}
    setTimeoutSeconds() {}
    setTimestampMode() {}
  },
}));

vi.mock('../src/ingest/datasets.js', () => ({ Ingestor: class { setMapping() {} } }));
vi.mock('../src/ingest/operations.js', () => ({ OperationCache: class { clear() {} async preload() {} } }));
vi.mock('../src/engine/standards.js', () => ({ StandardsRecomputer: class { async run() { return { pairs: 0, computed: 0, durationMs: 0 }; } } }));
vi.mock('../src/sync/backfill.js', () => ({
  Backfill: class {
    async ensureScheduled() {}
    async load() {}
    isActive() {
      return false;
    }
  },
}));

/** The poll itself is healthy: FactoryLogix answered and a row from three hours ago was ingested. */
vi.mock('../src/sync/poller.js', () => ({
  Poller: class {
    setSource() {}
    async pollOnce() {
      return { ok: true, rows: 1, touched: [Date.now() - 3 * 3_600_000], error: null, datasets: [], durationMs: 5 };
    }
  },
}));

const RECOMPUTE_ERROR = 'deadlock detected while rewriting hour_cells [rc-7731]';

/** The hour cell rebuild fails (database error, lock timeout, bad data...). */
vi.mock('../src/engine/recompute.js', () => ({
  Recomputer: class {
    async recomputeHours() {
      throw new Error('deadlock detected while rewriting hour_cells [rc-7731]');
    }
    async recomputeCurrentHours() {}
  },
}));

afterAll(() => {
  process.emit('SIGTERM');
});

describe('a poll whose hour cell recompute failed', () => {
  it('leaves a trace in the database, not only in the collector log', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('DATABASE_URL', 'postgres://fld:fld@db.invalid:5432/fld');
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('../src/index.js');
    // The loop reports its health right after the poll (and the recompute that follows it).
    await vi.waitFor(() => expect(h.db.some((c) => c.sql.includes('UPDATE collector_state SET'))).toBe(true), { timeout: 5_000 });

    // The failure is logged ...
    expect(h.logs.some((l) => l.level === 'error' && JSON.stringify(l.obj).includes(RECOMPUTE_ERROR))).toBe(true);

    // ... but nothing the API can read says the screens are no longer being refreshed.
    const persisted = h.db.filter((c) => c.params.some((p) => typeof p === 'string' && p.includes('rc-7731')));
    expect(persisted).not.toHaveLength(0);
  });
});
