/**
 * Red team: a long standards recompute or backfill chunk held up the heartbeat with the polls, so
 * the API called the collector stopped ("Collector down") while it was only busy, and nothing said
 * why no data came in (see heartbeat-during-long-job.test.ts for the heartbeat itself).
 *
 * This drives the real Collector loop (src/index.ts) with a fake clock. Every collaborator is
 * faked: the polls succeed with nothing new, and a standards recompute or a backfill chunk takes
 * `h.jobMs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';

const T0 = Date.parse('2026-06-02T05:58:00Z'); // 01:58 plant time, two minutes before the nightly run
const NIGHTLY = Date.parse('2026-06-02T06:00:00Z'); // 02:00 plant time
const DAYTIME = Date.parse('2026-06-02T14:00:00Z'); // 10:00 plant time
const POLL_MS = DEFAULT_SETTINGS.poll_interval_seconds * 1_000;
const MINUTE = 60_000;

const h = vi.hoisted(() => ({
  db: [] as { sql: string; params: unknown[]; at: number }[],
  /** Control commands not taken yet (NOTIFY fld_control). */
  commands: [] as unknown[],
  /** Every StandardsRecomputer.run: when, and for which product (null: every product). */
  runs: [] as { at: number; product: string | null }[],
  /** When each backfill chunk and each poll started. */
  chunks: [] as number[],
  polls: [] as number[],
  backfillActive: false,
  jobMs: 0,
}));

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
vi.mock('../src/sync/backfill.js', () => ({
  Backfill: class {
    async ensureScheduled() {}
    async load() {}
    isActive() {
      return h.backfillActive;
    }
    shouldRun() {
      return true;
    }
    async pause() {}
    tick() {
      h.chunks.push(Date.now());
      return new Promise((resolve) => setTimeout(() => resolve({ worked: true, finished: false }), h.jobMs));
    }
  },
}));
vi.mock('../src/sync/poller.js', () => ({
  Poller: class {
    setSource() {}
    async pollOnce() {
      h.polls.push(Date.now());
      return { ok: true, requiredOk: true, loginRefused: null, rows: 0, touched: [], error: null, datasets: [], durationMs: 5 };
    }
  },
}));
vi.mock('../src/engine/standards.js', () => ({
  StandardsRecomputer: class {
    run(opts: { productNumber?: string | null }) {
      h.runs.push({ at: Date.now(), product: opts.productNumber ?? null });
      return new Promise((resolve) => setTimeout(() => resolve({ pairs: 800, computed: 800, durationMs: h.jobMs }), h.jobMs));
    }
  },
}));

const heartbeats = () => h.db.filter((c) => c.sql.includes('heartbeat_at = now()'));

/** What the collector last wrote to collector_state (`HealthReporter.report`), and when. */
function collectorState() {
  const last = heartbeats().at(-1);
  const [, status, lastError] = (last?.params ?? []) as [Date | null, string, string | null];
  return { status, lastError, at: last?.at ?? null };
}

/** The longest stretch without a heartbeat between `from` and `to`. */
function longestHeartbeatGap(from: number, to: number): number {
  const marks = [from, ...heartbeats().map((c) => c.at).filter((at) => at > from && at < to), to];
  let longest = 0;
  for (let i = 1; i < marks.length; i++) longest = Math.max(longest, (marks[i] as number) - (marks[i - 1] as number));
  return longest;
}

const advanceTo = (at: number) => vi.advanceTimersByTimeAsync(Math.max(0, at - Date.now()));

beforeEach(async () => {
  vi.resetModules();
  h.db.length = 0;
  h.commands.length = 0;
  h.runs.length = 0;
  h.chunks.length = 0;
  h.polls.length = 0;
  h.backfillActive = false;
  h.jobMs = 0;
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

describe('while a long job holds up the polls', () => {
  it('the nightly standards recompute keeps the heartbeat, says why no poll comes in once the data is delayed, and polls as soon as it is done', async () => {
    h.jobMs = 20 * MINUTE;
    await import('../src/index.js');
    await advanceTo(NIGHTLY + POLL_MS); // the poll after 02:00 starts the nightly job
    expect(h.runs).toHaveLength(1);
    const started = h.runs[0].at;
    const polls = h.polls.length;

    // The data is not delayed yet: the heartbeat goes on, and Sync health has nothing to say.
    await advanceTo(started + 4 * MINUTE);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });

    // 3 poll intervals without one: the TVs say "Data delayed", and Sync health says why.
    await advanceTo(started + 5 * MINUTE + 1_000);
    expect(collectorState()).toMatchObject({
      status: 'degraded',
      lastError: 'the collector is recomputing the standards; polling resumes when that is done',
    });

    await advanceTo(started + 20 * MINUTE - 1);
    expect(h.polls).toHaveLength(polls);
    expect(longestHeartbeatGap(started, Date.now())).toBeLessThanOrEqual(30_000);

    // Done: the next poll goes out at once, not one poll interval later, and it all clears.
    await advanceTo(started + 20 * MINUTE + 1_000);
    expect(h.polls).toHaveLength(polls + 1);
    expect(h.polls.at(-1)).toBe(started + 20 * MINUTE);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
  });

  it('"Recompute now" on a product does the same', async () => {
    vi.setSystemTime(DAYTIME);
    h.jobMs = 10 * MINUTE;
    await import('../src/index.js');
    await vi.advanceTimersByTimeAsync(1_000);
    h.commands.push({ cmd: 'recompute_standards', product_number: 'P-1' });
    await vi.advanceTimersByTimeAsync(30_000); // taken when the current heartbeat slice ends
    expect(h.runs).toEqual([{ at: DAYTIME + 30_000, product: 'P-1' }]);
    const started = h.runs[0].at;

    await advanceTo(started + 6 * MINUTE);
    expect(collectorState()).toMatchObject({
      status: 'degraded',
      lastError: 'the collector is recomputing the standards of P-1; polling resumes when that is done',
    });
    expect(longestHeartbeatGap(started, Date.now())).toBeLessThanOrEqual(30_000);
  });

  it('a long backfill chunk does the same, with a poll before the next chunk', async () => {
    vi.setSystemTime(DAYTIME);
    h.backfillActive = true;
    h.jobMs = 6 * MINUTE;
    await import('../src/index.js');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.chunks).toEqual([DAYTIME]); // in the idle time after the first poll

    await advanceTo(DAYTIME + 5 * MINUTE + 1_000);
    expect(collectorState()).toMatchObject({
      status: 'degraded',
      lastError: 'the collector is processing a backfill chunk; polling resumes when that is done',
    });

    await advanceTo(DAYTIME + 6 * MINUTE + 1_000);
    expect(h.polls).toEqual([DAYTIME, DAYTIME + 6 * MINUTE]);
    expect(h.chunks).toEqual([DAYTIME, DAYTIME + 6 * MINUTE]);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
    expect(longestHeartbeatGap(DAYTIME, Date.now())).toBeLessThanOrEqual(30_000);
  });
});
