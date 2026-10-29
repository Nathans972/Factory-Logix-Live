/**
 * Red team (load): every repeat of "Recompute all standards" queued another full run.
 *
 * ControlListener queued every fld_control notification and the main loop ran each standards
 * recompute in full before the next poll, so pressing the button three times held up the polls three
 * times as long. A request is now dropped when a command still to run already does what it asks
 * (control.ts `alreadyRequested`), the standards recompute running at the time included.
 *
 * The first part drives ControlListener alone. The second drives the real Collector (src/index.ts)
 * with a scripted Postgres (the `pg` module is replaced), a fake clock, an OData source that returns
 * nothing and a StandardsRecomputer.run that takes 9 minutes, as one does at the SPEC's volume.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MappingConfig } from '@fld/shared';
import type { ControlCommand } from '../src/control.js';
import type { StandardsRunOptions } from '../src/engine/standards.js';
import type { Logger } from '../src/logger.js';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  handler: null as null | ((sql: string, params: unknown[]) => unknown),
  controlClients: [] as { emit: (event: string, ...args: unknown[]) => void }[],
}));

vi.mock('pg', () => {
  class FakePool {
    on(): this {
      return this;
    }
    async query(sql: string, params: unknown[] = []): Promise<unknown> {
      return h.handler?.(sql, params);
    }
    async connect(): Promise<unknown> {
      return { query: (sql: string, params: unknown[] = []) => h.handler?.(sql, params), release: () => undefined };
    }
    async end(): Promise<void> {}
  }
  class FakeClient {
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    constructor() {
      h.controlClients.push(this);
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }
    async connect(): Promise<void> {}
    async query(): Promise<unknown> {
      return { rows: [], rowCount: 0 };
    }
    async end(): Promise<void> {}
  }
  return { default: { Pool: FakePool, Client: FakeClient, types: { setTypeParser: () => undefined } } };
});

/** NOTIFY fld_control on the newest control connection, as the api's `sendControl` does. */
function send(command: object): void {
  h.controlClients[h.controlClients.length - 1]?.emit('notification', { channel: 'fld_control', payload: JSON.stringify(command) });
}

const ALL = { cmd: 'recompute_standards' };
const RESTART = { cmd: 'restart' };
const BACKFILL = { cmd: 'backfill_now' };
const CELLS = { cmd: 'recompute_cells', from_utc: 1_000, to_utc: 2_000 };
const product = (z: string) => ({ cmd: 'recompute_standards', product_number: z });
/** How a command comes out of `parseControlPayload`. */
const queued = (command: object): ControlCommand => ({ product_number: null, ...command }) as ControlCommand;

describe('ControlListener: a request made again', () => {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

  async function listener() {
    const { ControlListener } = await import('../src/control.js');
    const control = new ControlListener('postgres://unused', log);
    await control.start();
    return control;
  }

  it('is queued again after a restart, and an hour cell recompute after a standards recompute: what it computes may have changed', async () => {
    const control = await listener();
    for (const command of [CELLS, ALL, CELLS, RESTART, ALL]) send(command);
    expect(control.take()).toEqual([CELLS, queued(ALL), CELLS, RESTART, queued(ALL)]);
  });

  it('is not queued again for work in between that does not change what it computes', async () => {
    const control = await listener();
    send(ALL);
    send(BACKFILL); // "Run backfill now" or a product's "Recompute now" in between: the full run waiting still covers it
    send(ALL);
    send(product('P-1'));
    send(ALL);
    send(RESTART);
    send(BACKFILL);
    send(RESTART); // the restart waiting loads what was saved since when it runs
    send(CELLS);
    send(CELLS);
    expect(control.take()).toEqual([queued(ALL), BACKFILL, product('P-1'), RESTART, BACKFILL, CELLS]);
  });

  it('is queued once per product, however often the products are gone through', async () => {
    const control = await listener();
    for (let i = 0; i < 50; i++) for (const z of ['P-1', 'P-2', 'P-3']) send(product(z));
    send(ALL);
    send(product('P-2'));
    expect(control.take()).toEqual([product('P-1'), product('P-2'), product('P-3'), queued(ALL)]);
  });

  it('while that standards recompute runs is not queued, unless something else is waiting after it', async () => {
    const control = await listener();
    send(ALL);
    const [first] = control.take();
    control.running = first ?? null; // the main loop runs it
    send(ALL);
    send(ALL);
    expect(control.pending).toBe(0);
    send(product('P-1')); // other work, then the same request again: still covered by the run
    send(BACKFILL);
    send(ALL);
    send(RESTART); // settings saved meanwhile, then the recompute asked for again to apply them
    send(ALL);
    control.running = null;
    expect(control.take()).toEqual([product('P-1'), BACKFILL, RESTART, queued(ALL)]);
  });

  it('counts the commands the main loop took and has not run yet, but a restart running does not cover a new one', async () => {
    const control = await listener();
    send(RESTART);
    send(ALL);
    const taken = control.take();
    control.running = taken[0] ?? null; // the restart runs; the recompute it took after it has not started
    send(ALL); // covered by that one: it runs with what the restart loads
    send(RESTART); // the running restart may have read the settings before they were saved again
    expect(control.pending).toBe(1);
    control.running = taken[1] ?? null; // now the recompute runs, with a restart waiting after it
    send(ALL);
    control.running = null;
    expect(control.take()).toEqual([RESTART, queued(ALL)]);
  });
});

const START = Date.parse('2026-06-02T16:00:00Z'); // 12:00 plant time, far from the nightly 02:00 run
const RUN_MS = 9 * 60_000;

const mapping = {
  work_orders: { entity_set: 'WorkOrders', watermark_field: 'Modified', key: ['Job'], fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty', modified_at: 'Modified' } },
  unit_steps: {
    entity_set: 'UnitSteps',
    watermark_field: 'Done',
    key: ['StepId'],
    fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
  },
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

/** The statements an idle collector with nothing to ingest issues, answered from small in-memory state. */
function scriptedDatabase() {
  const collector = {
    heartbeat_at: null as Date | null,
    breaker_open_until: null as Date | null,
    status: 'never',
    last_error: null as string | null,
    last_success_at: null as Date | null,
    consecutive_failures: 0,
    last_standards_recompute_at: new Date(START - 10 * 3_600_000) as Date | null,
  };
  const settings: Row[] = [
    { key: 'plant_timezone', value: 'America/New_York' },
    { key: 'poll_interval_seconds', value: 30 },
    { key: 'late_data_hours', value: 0 },
    { key: 'backfill_days', value: 0 },
    { key: 'std_recompute_time', value: '02:00' },
    { key: 'mapping', value: mapping },
    { key: 'fl_connection', value: { base_url: 'http://factorylogix.invalid/odata', username: 'svc', password_enc: 'not-encrypted' } },
  ];
  const syncState = new Map<string, Row>();
  const unexpected: string[] = [];
  let logId = 0;
  const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });

  const handler = (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return ok();
    if (text.startsWith('INSERT INTO collector_state')) return ok();
    if (text.includes('FROM collector_state WHERE id = 1')) return ok([{ ...collector }]);
    if (text.startsWith('UPDATE collector_state SET last_standards_recompute_at')) {
      collector.last_standards_recompute_at = params[0] as Date;
      return ok([], 1);
    }
    if (text.startsWith('UPDATE collector_state SET heartbeat_at')) return ok([], 1);
    if (text === 'SELECT key, value FROM settings') return ok(settings);
    if (text === 'SELECT id, name FROM operations') return ok();
    if (text.includes('FROM sync_state WHERE source')) {
      const found = syncState.get(params[0] as string);
      return ok(found ? [{ ...found }] : []);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_success_at')) {
      const [source, watermark] = params as [string, string | null];
      const previous = syncState.get(source) ?? {};
      syncState.set(source, { source, consecutive_failures: 0, last_error: null, ...previous, watermark: watermark ?? previous.watermark ?? null });
      return ok([], 1);
    }
    if (text.startsWith("INSERT INTO sync_state (source, backfill_progress, updated_at) VALUES ('backfill'")) {
      syncState.set('backfill', { source: 'backfill', consecutive_failures: 0, backfill_progress: JSON.parse(params[0] as string) });
      return ok([], 1);
    }
    if (text.startsWith('INSERT INTO sync_log')) return ok([{ id: (logId += 1) }]);
    if (text.startsWith('UPDATE sync_log')) return ok([], 1);
    if (/FROM (shifts|breaks|standard_adjustments|standard_overrides|operator_pins)/.test(text)) return ok();
    if (text.includes('FROM standards s JOIN operations')) return ok();
    if (text.includes('FROM unit_steps us JOIN operations') || text.includes('FROM defects d JOIN operations')) return ok();
    if (text.startsWith('DELETE FROM hour_cells') || text.startsWith('DELETE FROM defect_hour_cells')) return ok();
    if (text.includes('FROM hour_cells c JOIN operations')) return ok();
    if (text.startsWith('SELECT pg_notify')) return ok();
    unexpected.push(text);
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { handler, unexpected };
}

/**
 * Starts a fresh collector, lets its first poll go by, then runs `script`, which sends commands and
 * moves the clock (`advance`). Returns how many recomputes of all standards the collector ran: the
 * on-demand ones (the nightly run starts from the last cutoff), as `fullRuns` counts them so far.
 */
async function fullRecomputes(
  script: (advance: (ms: number) => Promise<void>, fullRuns: () => number) => Promise<void>,
): Promise<{ runs: number; unexpected: string[] }> {
  vi.resetModules();
  const db = scriptedDatabase();
  const runs: StandardsRunOptions[] = [];
  const fullRuns = () => runs.filter((r) => !r.productNumber && r.since === null).length;
  h.handler = db.handler;
  h.controlClients.length = 0;
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  process.env.DATABASE_URL = 'postgres://fld:fld@db.invalid:5432/fld';
  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'silent';

  vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    const { StandardsRecomputer } = await import('../src/engine/standards.js');
    vi.spyOn(StandardsRecomputer.prototype, 'run').mockImplementation(async (runOpts: StandardsRunOptions) => {
      runs.push(runOpts);
      await new Promise((resolve) => setTimeout(resolve, RUN_MS));
      return { pairs: 7_500, computed: 7_500, durationMs: RUN_MS };
    });
    const { ODataSource } = await import('../src/sources/ODataSource.js');
    vi.spyOn(ODataSource.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(ODataSource.prototype, 'fetchPage').mockResolvedValue({ rows: [], nextLink: null } as never);

    await import('../src/index.js'); // starts the collector loop
    const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms).then(() => undefined);
    await advance(5_000); // first poll cycle; the loop now waits for the next one
    await script(advance, fullRuns);

    process.emit('SIGTERM');
    await advance(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
  return { runs: fullRuns(), unexpected: db.unexpected };
}

describe('Collector: "Recompute all standards" pressed again', () => {
  it('while it runs does not run it again; pressed after it is done, it does', async () => {
    const counted: number[] = [];
    const result = await fullRecomputes(async (advance, fullRuns) => {
      send(ALL); // the loop wakes up and starts the recompute
      await advance(60_000);
      send(ALL); // "Recompute started." and nothing else changes on the page: pressed twice more
      send(ALL);
      await advance(RUN_MS + 5 * 60_000); // the run ends and the polls resume
      counted.push(fullRuns());
      send(ALL); // pressed once "Last recompute" has moved: a new request
      await advance(RUN_MS + 60_000);
    });
    expect(result.unexpected).toEqual([]);
    expect(counted).toEqual([1]);
    expect(result.runs).toBe(2);
  });

  it('runs it again when settings were saved in between, so that it uses them', async () => {
    const result = await fullRecomputes(async (advance) => {
      send(ALL);
      await advance(60_000);
      send(RESTART); // what the api sends after any admin save
      send(ALL);
      await advance(2 * RUN_MS + 5 * 60_000);
    });
    expect(result.unexpected).toEqual([]);
    expect(result.runs).toBe(2);
  });

  it('runs it again when a restart taken with it is still to run after it', async () => {
    const result = await fullRecomputes(async (advance) => {
      send(ALL); // both are waiting when the loop takes them: the recompute runs first, with the old settings
      send(RESTART);
      await advance(60_000);
      send(ALL); // pressed again to apply what was saved
      await advance(2 * RUN_MS + 5 * 60_000);
    });
    expect(result.unexpected).toEqual([]);
    expect(result.runs).toBe(2);
  });
});
