/**
 * Red team: a failing nightly standards job was only logged (see standards-failure-visible.test.ts),
 * and since its next run only moved on after a success, it ran again at the end of every poll.
 *
 * This drives the real Collector loop (src/index.ts) through the night with a fake clock. Every
 * collaborator is faked: the polls succeed with nothing new, and StandardsRecomputer.run fails
 * while `h.standardsError` is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';

const T0 = Date.parse('2026-06-02T05:58:00Z'); // 01:58 plant time, two minutes before the nightly run
const NIGHTLY = Date.parse('2026-06-02T06:00:00Z'); // 02:00 plant time
const POLL_MS = DEFAULT_SETTINGS.poll_interval_seconds * 1_000;
const MINUTE = 60_000;

const h = vi.hoisted(() => ({
  db: [] as { sql: string; params: unknown[] }[],
  /** The sync_state rows an earlier collector left, by source. */
  syncState: new Map<string, Record<string, unknown>>(),
  /** Control commands not taken yet (NOTIFY fld_control). */
  commands: [] as unknown[],
  /** Every StandardsRecomputer.run: when, and for which product (null: every product). */
  runs: [] as { at: number; product: string | null }[],
  standardsError: null as string | null,
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  const record = (sql: string, params: unknown[] = []) => h.db.push({ sql, params });
  return {
    ...actual,
    createPool: () => ({ end: async () => undefined, query: async () => ({ rows: [], rowCount: 0 }) }),
    exec: async (_db: unknown, sql: string, params?: unknown[]) => (record(sql, params), 1),
    q: async (_db: unknown, sql: string, params?: unknown[]) => (record(sql, params), []),
    q1: async (_db: unknown, sql: string, params: unknown[] = []) => {
      record(sql, params);
      return sql.includes('FROM sync_state WHERE source') ? (h.syncState.get(params[0] as string) ?? null) : null;
    },
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
vi.mock('../src/engine/standards.js', () => ({
  StandardsRecomputer: class {
    async run(opts: { productNumber?: string | null }) {
      h.runs.push({ at: Date.now(), product: opts.productNumber ?? null });
      if (h.standardsError) throw new Error(h.standardsError);
      return { pairs: 3, computed: 3, durationMs: 40 };
    }
  },
}));

/** What the collector last wrote to collector_state (`HealthReporter.report`). */
function collectorState() {
  const writes = h.db.filter((c) => c.sql.includes('heartbeat_at = now()'));
  const [, status, lastError, lastSuccessAt] = (writes.at(-1)?.params ?? []) as [Date | null, string, string | null, Date | null];
  return { status, lastError, lastSuccessAt: lastSuccessAt?.getTime() ?? null };
}

/** The last write to the sync_state row of the standards recompute (`recordSyncSuccess` / `recordSyncFailure`). */
function standardsRow() {
  const last = h.db.filter((c) => c.sql.includes('INSERT INTO sync_state') && c.params[0] === 'standards_recompute').at(-1);
  if (!last) return null;
  return last.sql.includes('last_success_at') ? { ok: true, rows: last.params[2] } : { ok: false, error: last.params[1] };
}

const nightlyRuns = () => h.runs.filter((r) => r.product === null);
const advanceTo = (at: number) => vi.advanceTimersByTimeAsync(Math.max(0, at - Date.now()));

beforeEach(async () => {
  vi.resetModules();
  h.db.length = 0;
  h.syncState.clear();
  h.commands.length = 0;
  h.runs.length = 0;
  h.standardsError = null;
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

describe('a nightly standards recompute that fails', () => {
  it('stays in the sync health while the polls go through, and is tried again with a backoff, not after every poll', async () => {
    h.standardsError = 'could not serialize access while writing standards';
    await import('../src/index.js');
    await advanceTo(NIGHTLY + POLL_MS); // the poll after 02:00 runs the nightly job
    expect(nightlyRuns()).toHaveLength(1);
    const failedAt = nightlyRuns()[0].at; // 02:01 plant time
    expect(standardsRow()).toEqual({ ok: false, error: 'could not serialize access while writing standards' });

    // The polls since have gone through: the data is current, but the status says StdHr is going stale.
    await advanceTo(failedAt + 9 * MINUTE);
    expect(nightlyRuns()).toHaveLength(1);
    const state = collectorState();
    expect(state.status).toBe('degraded');
    expect(state.lastError).toBe(
      'could not recompute the standards (could not serialize access while writing standards); StdHr stays as last computed, the collector tries again at 02:11',
    );
    expect(Date.now() - (state.lastSuccessAt as number)).toBeLessThanOrEqual(POLL_MS);

    // Tried again 10 minutes later, then 20 minutes after that.
    await advanceTo(failedAt + 10 * MINUTE + POLL_MS);
    expect(nightlyRuns()).toHaveLength(2);
    const retriedAt = nightlyRuns()[1].at;
    expect(retriedAt - failedAt).toBeGreaterThanOrEqual(10 * MINUTE);
    await advanceTo(retriedAt + 20 * MINUTE - 1);
    expect(nightlyRuns()).toHaveLength(2);
    expect(collectorState().lastError).toContain('tries again at 02:31');

    // The cause is gone: the next retry goes through, and it all clears.
    h.standardsError = null;
    await advanceTo(retriedAt + 20 * MINUTE + POLL_MS);
    expect(nightlyRuns()).toHaveLength(3);
    await advanceTo(Date.now() + POLL_MS);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
    expect(standardsRow()).toEqual({ ok: true, rows: 3 });

    // And the next run is tomorrow night's.
    await advanceTo(NIGHTLY + 12 * 60 * MINUTE);
    expect(nightlyRuns()).toHaveLength(3);
  });

  it('read back after a restart, is still shown and tried again after its backoff, not only tomorrow night', async () => {
    const start = Date.parse('2026-06-02T14:00:00Z'); // 10:00 plant time
    vi.setSystemTime(start);
    h.syncState.set('standards_recompute', {
      source: 'standards_recompute',
      watermark: null,
      last_success_at: new Date(start - 2 * 24 * 60 * MINUTE),
      last_error: 'out of shared memory',
      consecutive_failures: 2,
      rows_last_poll: null,
      duration_ms_last_poll: 1_200,
      backfill_progress: null,
    });
    h.standardsError = 'out of shared memory';
    await import('../src/index.js');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(collectorState()).toMatchObject({
      status: 'degraded',
      lastError: 'could not recompute the standards (out of shared memory); StdHr stays as last computed, the collector tries again at 10:20',
    });

    // Its third attempt waits 20 minutes, as it would have without the restart.
    await advanceTo(start + 20 * MINUTE - 1);
    expect(nightlyRuns()).toHaveLength(0);
    await advanceTo(start + 23 * MINUTE);
    expect(nightlyRuns()).toHaveLength(1);
    expect(collectorState().lastError).toContain('tries again at 11:01');
  });

  it('ends with "Recompute all standards now", but not with a recompute of one product', async () => {
    h.standardsError = 'deadlock detected';
    await import('../src/index.js');
    await advanceTo(NIGHTLY + POLL_MS);
    expect(nightlyRuns()).toHaveLength(1);
    h.standardsError = null;

    h.commands.push({ cmd: 'recompute_standards', product_number: 'P-1' });
    await advanceTo(Date.now() + POLL_MS);
    expect(h.runs.at(-1)).toMatchObject({ product: 'P-1' });
    expect(collectorState().status).toBe('degraded');

    h.commands.push({ cmd: 'recompute_standards' });
    await advanceTo(Date.now() + POLL_MS);
    expect(nightlyRuns()).toHaveLength(2);
    expect(collectorState()).toMatchObject({ status: 'ok', lastError: null });
    expect(standardsRow()).toEqual({ ok: true, rows: 3 });

    // Its retry is not needed any more.
    await advanceTo(NIGHTLY + 6 * 60 * MINUTE);
    expect(nightlyRuns()).toHaveLength(2);
  });
});
