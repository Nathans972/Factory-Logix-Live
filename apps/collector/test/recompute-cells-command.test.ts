/**
 * `recompute_cells`, which the API sends after a change the stored hour cells depend on (an engine
 * setting, a shift, a break; docs/API.md): the collector recomputes every hour of the range, and
 * the hours it could not are tried again after every poll, as those of a poll are.
 *
 * This drives the real Collector loop (src/index.ts) with a fake clock and the collaborators faked
 * as in rt1-recompute-retry.test.ts; the control channel hands over the commands each test queues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hourStartUtc } from '@fld/engine';
import { DEFAULT_SETTINGS } from '@fld/shared';

const TZ = 'America/New_York';
const T0 = Date.parse('2026-06-02T15:00:00Z'); // 11:00 plant time: every poll below is in this hour
const POLL_MS = DEFAULT_SETTINGS.poll_interval_seconds * 1_000;
const HOUR = 3_600_000;

const h = vi.hoisted(() => ({
  db: [] as { sql: string; params: unknown[] }[],
  /** Commands the control channel hands over at the next `take()`. */
  commands: [] as unknown[],
  listener: null as { onCommand: (() => void) | null } | null,
  /** Every recomputeHours call: its hours (sorted) and whether it went through. */
  recomputes: [] as { hours: number[]; ok: boolean }[],
  /** Why the Recomputer fails these hours, or null when it does not. */
  fail: (() => null) as (hours: number[]) => string | null,
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
  const quiet = () => undefined;
  return { ...actual, createLogger: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
});

vi.mock('../src/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/settings.js')>()),
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
    constructor() {
      h.listener = this;
    }
    async start() {}
    take() {
      return h.commands.splice(0);
    }
    get pending() {
      return h.commands.length;
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

vi.mock('../src/sync/poller.js', () => ({
  Poller: class {
    setSource() {}
    async pollOnce() {
      return { ok: true, requiredOk: true, loginRefused: null, rows: 0, touched: [], error: null, datasets: [], durationMs: 5 };
    }
  },
}));

vi.mock('../src/engine/recompute.js', () => ({
  Recomputer: class {
    async recomputeHours(hourStarts: Iterable<number>) {
      const hours = [...hourStarts].sort((a, b) => a - b);
      const error = h.fail(hours);
      h.recomputes.push({ hours, ok: error === null });
      if (error) throw new Error(error);
      return { hours, ranges: 1, cells: 0, durationMs: 0 };
    }
    async recomputeCurrentHours() {}
  },
}));

const CURRENT = hourStartUtc(T0, TZ);
const PREVIOUS = CURRENT - HOUR;
/** The hours from 05:00 to 11:00 plant time. */
const RANGE = [5, 4, 3, 2, 1, 0].map((back) => CURRENT - back * HOUR);
/** What the API sends for them: from inside the first hour to now, in the last one. */
const COMMAND = { cmd: 'recompute_cells', from_utc: RANGE[0] + 20 * 60_000, to_utc: T0 + 30 * 60_000 };

/** What the collector last wrote to collector_state (`HealthReporter.report`). */
function collectorState() {
  const writes = h.db.filter((c) => c.sql.includes('UPDATE collector_state SET'));
  const [, status, lastError] = (writes.at(-1)?.params ?? []) as [Date | null, string, string | null];
  return { status, lastError };
}

/** The recomputeHours calls of what `run` drives. */
async function recomputes(run: () => Promise<unknown>) {
  const from = h.recomputes.length;
  await run();
  return h.recomputes.slice(from);
}

const nextPoll = () => vi.advanceTimersByTimeAsync(POLL_MS);

/** The API's NOTIFY arrives while the collector waits for the next poll. */
async function send(command: unknown) {
  h.commands.push(command);
  h.listener?.onCommand?.();
  await vi.advanceTimersByTimeAsync(1_000);
}

beforeEach(async () => {
  vi.resetModules();
  h.db.length = 0;
  h.commands.length = 0;
  h.listener = null;
  h.recomputes.length = 0;
  h.fail = () => null;
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('DATABASE_URL', 'postgres://fld:fld@db.invalid:5432/fld');
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  await import('../src/index.js');
  await vi.advanceTimersByTimeAsync(1_000);
});

afterEach(async () => {
  process.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('recompute_cells', () => {
  it('recomputes every hour from the one from_utc is in up to to_utc, then polls', async () => {
    expect(await recomputes(() => send(COMMAND))).toEqual([
      { hours: RANGE, ok: true },
      { hours: [PREVIOUS, CURRENT], ok: true },
    ]);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
  });

  it('tries the hours it could not recompute again after every poll until they go through', async () => {
    h.fail = (hours) => (hours.length > 2 ? 'deadlock detected while rewriting hour_cells' : null);
    // The poll right after it does its own two hours, then the others again.
    expect(await recomputes(() => send(COMMAND))).toEqual([
      { hours: RANGE, ok: false },
      { hours: [PREVIOUS, CURRENT], ok: true },
      { hours: RANGE.slice(0, 4), ok: false },
    ]);
    expect(collectorState()).toEqual({
      status: 'degraded',
      lastError: 'could not recompute the hour cells of 4 hours (deadlock detected while rewriting hour_cells); the collector tries again after every poll',
    });

    h.fail = () => null;
    expect(await recomputes(nextPoll)).toEqual([
      { hours: [PREVIOUS, CURRENT], ok: true },
      { hours: RANGE.slice(0, 4), ok: true },
    ]);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
    expect(await recomputes(nextPoll)).toEqual([{ hours: [PREVIOUS, CURRENT], ok: true }]);
  });
});
