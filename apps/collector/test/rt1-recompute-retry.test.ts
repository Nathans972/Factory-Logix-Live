/**
 * Red team: a poll whose hour cell recompute failed was reported healthy, and its hours were never
 * recomputed again: the watermarks had moved past their rows, so the next poll only recomputed the
 * current and previous hour (see recompute-failure-visible.test.ts for the first half).
 *
 * This drives the real Collector loop (src/index.ts) over several polls with a fake clock. Every
 * collaborator is faked as in recompute-failure-visible.test.ts: the polls succeed and touch the
 * instants each test gives them, and the Recomputer fails the hours each test says it fails.
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
  /** The instants each poll touches, in order; a poll past the end touches nothing. */
  touched: [] as number[][],
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

vi.mock('../src/sync/poller.js', () => ({
  Poller: class {
    setSource() {}
    async pollOnce() {
      const touched = h.touched.shift() ?? [];
      return { ok: true, requiredOk: true, loginRefused: null, rows: touched.length, touched, error: null, datasets: [], durationMs: 5 };
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

/** What the collector last wrote to collector_state (`HealthReporter.report`). */
function collectorState() {
  const writes = h.db.filter((c) => c.sql.includes('UPDATE collector_state SET'));
  const [openUntil, status, lastError, lastSuccessAt, failures] = (writes.at(-1)?.params ?? []) as [Date | null, string, string | null, Date | null, number];
  return { openUntil, status, lastError, lastSuccessAt: lastSuccessAt?.getTime() ?? null, failures };
}

/** The recomputeHours calls of the poll that `run` drives. */
async function poll(run: () => Promise<unknown>) {
  const from = h.recomputes.length;
  await run();
  return h.recomputes.slice(from);
}

const nextPoll = () => vi.advanceTimersByTimeAsync(POLL_MS);

beforeEach(async () => {
  vi.resetModules();
  h.db.length = 0;
  h.touched.length = 0;
  h.recomputes.length = 0;
  h.fail = () => null;
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('DATABASE_URL', 'postgres://fld:fld@db.invalid:5432/fld');
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(async () => {
  process.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('hours whose recompute failed', () => {
  it('are recomputed again with the next poll, and the data shows as not current until they are', async () => {
    const late = T0 - 5 * HOUR - 20 * 60_000; // a late row of 05:40 plant time, ingested by the second poll
    const lateHour = hourStartUtc(late, TZ);
    h.touched.push([], [late], []);

    // First poll: everything goes through.
    await poll(async () => {
      await import('../src/index.js');
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const firstSuccess = collectorState().lastSuccessAt;
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
    expect(firstSuccess).not.toBeNull();

    // Second poll: the late row comes in, and the hour cell rewrite fails.
    h.fail = () => 'deadlock detected while rewriting hour_cells';
    expect(await poll(nextPoll)).toEqual([{ hours: [lateHour, PREVIOUS, CURRENT], ok: false }]);
    const failed = collectorState();
    expect(failed.status).toBe('degraded');
    expect(failed.lastError).toBe(
      'could not recompute the hour cells of 3 hours (deadlock detected while rewriting hour_cells); the collector tries again after every poll',
    );
    // The numbers on screen are those of the first poll: so is the last success ("Data delayed" once
    // that is 3 polls old). FactoryLogix answered, so there is no backoff.
    expect(failed.lastSuccessAt).toBe(firstSuccess);
    expect(failed.failures).toBe(0);
    expect(failed.openUntil).toBeNull();

    // Third poll: nothing new arrives, but the late row's hour is recomputed again, after the current ones.
    h.fail = () => null;
    expect(await poll(nextPoll)).toEqual([
      { hours: [PREVIOUS, CURRENT], ok: true },
      { hours: [lateHour], ok: true },
    ]);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
    expect(collectorState().lastSuccessAt).toBeGreaterThan(firstSuccess as number);

    // And once it went through, it is not recomputed again.
    expect(await poll(nextPoll)).toEqual([{ hours: [PREVIOUS, CURRENT], ok: true }]);
  });

  it('that keep failing do not hold back the current hour or other earlier hours, and keep the data delayed', async () => {
    const bad = hourStartUtc(T0 - 5 * HOUR, TZ); // a row in this hour makes every recompute of it fail
    const other = hourStartUtc(T0 - 8 * HOUR, TZ); // this one only failed with it
    h.touched.push([], [T0 - 5 * HOUR, T0 - 8 * HOUR]);
    h.fail = (hours) => (hours.includes(bad) ? 'value out of range for type integer' : null);

    await poll(async () => {
      await import('../src/index.js');
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const firstSuccess = collectorState().lastSuccessAt as number;

    expect(await poll(nextPoll)).toEqual([{ hours: [other, bad, PREVIOUS, CURRENT].sort((a, b) => a - b), ok: false }]);

    // Every later poll recomputes the current hours first, then each earlier range on its own.
    expect(await poll(nextPoll)).toEqual([
      { hours: [PREVIOUS, CURRENT], ok: true },
      { hours: [other], ok: true },
      { hours: [bad], ok: false },
    ]);
    for (let i = 0; i < 3; i += 1) {
      expect(await poll(nextPoll)).toEqual([
        { hours: [PREVIOUS, CURRENT], ok: true },
        { hours: [bad], ok: false },
      ]);
    }

    const state = collectorState();
    expect(state.status).toBe('degraded');
    expect(state.lastError).toBe(
      'could not recompute the hour cells of 1 hour (value out of range for type integer); the collector tries again after every poll',
    );
    expect(state.lastSuccessAt).toBe(firstSuccess);
    // The api's "delayed" (Data delayed banner): the last success is older than 3x the poll interval.
    expect(Date.now() - firstSuccess).toBeGreaterThan(3 * POLL_MS);
  });
});
