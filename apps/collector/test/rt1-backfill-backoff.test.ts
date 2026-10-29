/**
 * Red team: a backfill chunk that failed was run again on the next idle pass, every
 * backfill_pause_seconds (5 s), for as long as the window was open or for good after "Run backfill
 * now": about 700 downloads of the same day an hour, with the status left at `running` (see
 * backfill-failing-chunk.test.ts).
 *
 * This drives the real Collector loop (src/index.ts) and the real Backfill with a fake clock. The
 * other collaborators are faked: the polls succeed with nothing new, the backfill's pulls of unit
 * steps fail with HTTP 503 while `h.flDown` is set, and sync_state('backfill') lives in `h.backfill`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type BackfillProgress } from '@fld/shared';

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const POLL_MS = DEFAULT_SETTINGS.poll_interval_seconds * SECOND;
const NIGHT = Date.parse('2026-06-03T03:00:00Z'); // 23:00 plant time, inside the 22:00-05:00 window

const h = vi.hoisted(() => ({
  /** sync_state('backfill').backfill_progress as the collector last saved it. */
  backfill: null as BackfillProgress | null,
  /** Control commands not taken yet (NOTIFY fld_control). */
  commands: [] as unknown[],
  polls: [] as number[],
  /** Every pull of unit steps by the backfill: when, and the start of the day it asked for. */
  pulls: [] as { at: number; from: number }[],
  flDown: false,
  standardsRuns: [] as number[],
  standardsError: null as string | null,
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...actual,
    createPool: () => ({ end: async () => undefined, query: async () => ({ rows: [], rowCount: 0 }) }),
    exec: async (_db: unknown, sql: string, params: unknown[] = []) => {
      if (sql.includes("VALUES ('backfill'")) h.backfill = JSON.parse(params[0] as string) as BackfillProgress;
      return 1;
    },
    q: async () => [],
    q1: async (_db: unknown, sql: string, params: unknown[] = []) =>
      sql.includes('FROM sync_state WHERE source') && params[0] === 'backfill' && h.backfill
        ? { source: 'backfill', last_success_at: null, consecutive_failures: 0, rows_last_poll: null, duration_ms_last_poll: null, backfill_progress: structuredClone(h.backfill) }
        : null,
    notify: async () => undefined,
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
vi.mock('../src/engine/recompute.js', () => ({
  Recomputer: class {
    async recomputeHours() {
      return {};
    }
    async recomputeCurrentHours() {}
  },
}));
vi.mock('../src/sync/poller.js', () => ({
  Poller: class {
    setSource() {}
    async pollOnce() {
      h.polls.push(Date.now());
      return { ok: true, requiredOk: true, loginRefused: null, rows: 0, touched: [], error: null, datasets: [], durationMs: 5 };
    }
    async pullWindow(dataset: string, _mapping: unknown, _settings: unknown, opts: { from: number }) {
      if (dataset === 'unit_steps') {
        h.pulls.push({ at: Date.now(), from: opts.from });
        if (h.flDown) throw new Error('OData request failed with HTTP 503 Service Unavailable');
      }
      return { rows: 0, ingested: 0, skipped: 0, truncated: false };
    }
  },
}));
vi.mock('../src/engine/standards.js', () => ({
  StandardsRecomputer: class {
    async run() {
      h.standardsRuns.push(Date.now());
      if (h.standardsError) throw new Error(h.standardsError);
      return { pairs: 3, computed: 3, durationMs: 40 };
    }
  },
}));

const advanceTo = (at: number) => vi.advanceTimersByTimeAsync(Math.max(0, at - Date.now()));
const RETRY_MESSAGE = /\(failed \d+ times in a row\); the collector tries again at \d\d:\d\d, or at once on "Run backfill now"$/;

beforeEach(async () => {
  vi.resetModules();
  h.backfill = null;
  h.commands.length = 0;
  h.polls.length = 0;
  h.pulls.length = 0;
  h.flDown = false;
  h.standardsRuns.length = 0;
  h.standardsError = null;
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('DATABASE_URL', 'postgres://fld:fld@db.invalid:5432/fld');
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.useFakeTimers({ now: NIGHT, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(async () => {
  process.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a backfill chunk that keeps failing', () => {
  it('is tried 3 times, then on the poll breaker backoff with the backfill in error, and goes on once it goes through', async () => {
    h.flDown = true;
    await import('../src/index.js');
    await advanceTo(NIGHT + HOUR);

    const at = h.pulls.map((p) => p.at);
    expect(new Set(h.pulls.map((p) => p.from)).size).toBe(1); // the same day every time
    expect(at[2]! - at[0]!).toBeLessThanOrEqual(10 * SECOND); // three tries at the usual pace...
    for (let i = 3; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(2 * POLL_MS); // ...then 2x, 4x ... the poll interval
    expect(at.length).toBeLessThanOrEqual(11);
    expect(h.polls.length).toBeGreaterThanOrEqual(35); // the polls go on meanwhile
    expect(h.backfill).toMatchObject({ status: 'error', days_done: 0, failures: at.length });
    expect(h.backfill?.error).toMatch(/^OData request failed with HTTP 503 Service Unavailable /);
    expect(h.backfill?.error).toMatch(RETRY_MESSAGE);

    // FactoryLogix answers again: the day goes through at the next try, and the next days follow at the usual pace.
    h.flDown = false;
    await advanceTo((h.backfill?.retry_at as number) + 2 * MINUTE);
    expect(h.backfill).toMatchObject({ status: 'running', failures: 0, retry_at: null, error: null });
    expect(h.backfill?.days_done).toBeGreaterThanOrEqual(10);
  });

  it('"Run backfill now" tries the failed day again at once, where the backfill stopped', async () => {
    await import('../src/index.js');
    await advanceTo(NIGHT + 12 * SECOND); // the first days go through
    const done = h.backfill?.days_done as number;
    expect(done).toBeGreaterThan(0);
    h.flDown = true;
    await advanceTo(NIGHT + 40 * SECOND); // the next day fails three times
    expect(h.backfill).toMatchObject({ status: 'error', days_done: done, failures: 3 });
    const tries = h.pulls.length;
    const firstDay = h.backfill?.first_day;

    h.commands.push({ cmd: 'backfill_now' });
    await advanceTo(NIGHT + 90 * SECOND);
    // One more try of the same day long before the backoff is over, then it backs off again.
    expect(h.pulls).toHaveLength(tries + 1);
    expect(h.pulls.at(-1)?.from).toBe(h.pulls.at(-2)?.from);
    expect(h.backfill).toMatchObject({ status: 'error', requested_now: true, days_done: done, first_day: firstDay, failures: 4 });
  });

  it('keeps showing error once the window closes, and is tried again when it opens', async () => {
    const start = Date.parse('2026-06-03T08:58:00Z'); // 04:58 plant time, two minutes before the window closes
    vi.setSystemTime(start);
    h.flDown = true;
    await import('../src/index.js');
    await advanceTo(start + 30 * MINUTE);
    expect(h.pulls).toHaveLength(3);
    expect(h.backfill).toMatchObject({ status: 'error', failures: 3 });
    expect(h.backfill?.error).toContain('the collector tries again at 22:00, or at once on "Run backfill now"');

    const opens = Date.parse('2026-06-04T02:00:00Z'); // 22:00 plant time
    await advanceTo(opens - MINUTE);
    expect(h.pulls).toHaveLength(3);
    expect(h.backfill?.status).toBe('error');
    await advanceTo(opens + 2 * MINUTE);
    expect(h.pulls).toHaveLength(4);
  });

  it('backs off the standards recompute after the download the same way', async () => {
    h.backfill = {
      status: 'recoloring',
      requested_now: false,
      days_total: DEFAULT_SETTINGS.backfill_days,
      days_done: DEFAULT_SETTINGS.backfill_days,
      current_day: null,
      first_day: '2025-12-04',
      standards_done: false,
      recolor_days_done: 0,
      started_at: NIGHT - 24 * HOUR,
      finished_at: null,
      error: null,
    };
    h.standardsError = 'deadlock detected';
    await import('../src/index.js');
    await advanceTo(NIGHT + HOUR);
    expect(h.standardsRuns.length).toBeLessThanOrEqual(11);
    expect(h.backfill).toMatchObject({ status: 'error', standards_done: false, failures: h.standardsRuns.length });
    expect(h.backfill?.error).toMatch(/^deadlock detected /);
    expect(h.backfill?.error).toMatch(RETRY_MESSAGE);
  });
});
