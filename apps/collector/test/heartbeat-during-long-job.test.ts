import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';

/**
 * Drives the real Collector loop (src/index.ts) on a fake clock. The nightly standards job is
 * due and takes 20 minutes (a year of steps for every product and operation). The API calls the
 * collector stopped (collector_running = false, "Collector down" in the portal, "Data delayed"
 * on every TV) once its heartbeat is older than 3 x poll_interval_seconds; the collector's own
 * health.ts promises a heartbeat "at least every 30 s".
 */
const h = vi.hoisted(() => ({
  db: [] as { sql: string; params: unknown[]; at: number }[],
  standardsRuns: 0,
  nextLocalTimeCalls: 0,
}));

vi.mock('@fld/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fld/engine')>();
  // 02:00 has passed on the first iteration (the job is due); afterwards the next run is tomorrow.
  return { ...actual, nextLocalTime: () => (h.nextLocalTimeCalls++ === 0 ? Date.now() - 60_000 : Date.now() + 86_400_000) };
});

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  const record = (sql: string, params: unknown[] = []) => h.db.push({ sql, params, at: Date.now() });
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
  const quiet = () => undefined;
  return { ...actual, createLogger: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
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

/** The nightly recompute is slow: 20 minutes of fake time, nothing else happening in the process. */
vi.mock('../src/engine/standards.js', () => ({
  StandardsRecomputer: class {
    run() {
      h.standardsRuns += 1;
      return new Promise((resolve) => setTimeout(() => resolve({ pairs: 800, computed: 800, durationMs: 1_200_000 }), 20 * 60_000));
    }
  },
}));

afterAll(() => {
  process.emit('SIGTERM');
  vi.useRealTimers();
});

describe('the collector heartbeat while a long standards recompute runs', () => {
  it('keeps beating more often than the API tolerates (3 x poll interval)', async () => {
    vi.useFakeTimers({ now: Date.parse('2025-03-04T07:00:00Z') });
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('DATABASE_URL', 'postgres://fld:fld@db.invalid:5432/fld');
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('../src/index.js');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.standardsRuns).toBe(1); // the job started right after the first poll and is still running

    // The same threshold buildSyncHealth uses for collector_running / delayed.
    const staleMs = DEFAULT_SETTINGS.poll_interval_seconds * 3 * 1000;
    const started = Date.now();
    for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 10_000) await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(5_000); // the job has finished by now

    const beats = h.db.filter((c) => c.sql.includes('UPDATE collector_state SET') && c.sql.includes('heartbeat_at = now()')).map((c) => c.at);
    // Longest stretch without a heartbeat from the start of the job until it finished.
    const marks = [started, ...beats.filter((t) => t >= started), started + 20 * 60_000];
    let longest = 0;
    for (let i = 1; i < marks.length; i++) longest = Math.max(longest, (marks[i] as number) - (marks[i - 1] as number));

    expect(longest).toBeLessThan(staleMs);
  });
});
