import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';

/**
 * Drives the real Collector loop (src/index.ts) for one iteration with every collaborator faked,
 * and records everything it asks the database to store. The nightly standards job is due and
 * fails; today that is only a log line, and the dashboards keep using stale StdHr values.
 */
const h = vi.hoisted(() => ({
  db: [] as { sql: string; params: unknown[] }[],
  logs: [] as { level: string; obj: unknown; msg: unknown }[],
  standardsRuns: 0,
}));

vi.mock('@fld/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fld/engine')>();
  // The 02:00 run time has passed: the nightly job is due on the first iteration.
  return { ...actual, nextLocalTime: () => Date.now() - 60_000 };
});

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
vi.mock('../src/engine/recompute.js', () => ({
  Recomputer: class {
    async recomputeHours() {
      return {};
    }
    async recomputeCurrentHours() {}
  },
}));
vi.mock('../src/sync/backfill.js', () => ({
  Backfill: class {
    async ensureScheduled() {}
    async load() {}
    isActive() {
      return false;
    }
  },
}));
vi.mock('../src/sync/poller.js', () => ({
  Poller: class {
    setSource() {}
    async pollOnce() {
      return { ok: true, rows: 0, touched: [], error: null, datasets: [], durationMs: 5 };
    }
  },
}));

/** The standards computation fails (database error, out of memory, a pair the engine chokes on...). */
vi.mock('../src/engine/standards.js', () => ({
  StandardsRecomputer: class {
    async run() {
      h.standardsRuns += 1;
      throw new Error('could not serialize access while writing standards [sr-4471]');
    }
  },
}));

afterAll(() => {
  process.emit('SIGTERM');
});

describe('a nightly standards recompute that failed', () => {
  it('leaves a trace in the database, not only in the collector log', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('DATABASE_URL', 'postgres://fld:fld@db.invalid:5432/fld');
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('../src/index.js');
    await vi.waitFor(() => expect(h.logs.some((l) => l.msg === 'standards recompute failed')).toBe(true), { timeout: 5_000 });
    expect(h.standardsRuns).toBeGreaterThan(0);

    // The failure is logged ...
    expect(h.logs.some((l) => l.level === 'error' && JSON.stringify(l.obj).includes('sr-4471'))).toBe(true);

    // ... but nothing the API can read (collector_state.last_error, a sync_state / sync_log row, ...)
    // says the standards are out of date, so Admin > Sync still shows a healthy collector.
    const persisted = h.db.filter((c) => c.params.some((p) => typeof p === 'string' && p.includes('sr-4471')));
    expect(persisted).not.toHaveLength(0);
  });
});
