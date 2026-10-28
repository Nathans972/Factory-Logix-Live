/**
 * Red team (data integrity): "Recompute now" on one product moves the cutoff of the nightly job.
 *
 * The nightly standards job only recomputes the (product, operation) pairs whose unit_steps changed
 * after collector_state.last_standards_recompute_at (index.ts `maybeRecomputeStandards`, `since`).
 * The on-demand command writes that same column after EVERY run, including a run limited to one
 * product (index.ts `runCommand`, case 'recompute_standards'). Every other product that got rows
 * since the previous full run is then skipped by the next nightly job.
 *
 * This drives the real Collector (src/index.ts) with a scripted Postgres (the `pg` module is
 * replaced), a fake clock and an OData source that returns nothing. Only StandardsRecomputer.run is
 * replaced, to record the options each run was given.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MappingConfig } from '@fld/shared';
import type { StandardsRunOptions } from '../src/engine/standards.js';

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

const PREVIOUS_FULL_RUN = Date.parse('2026-06-01T06:00:05Z'); // last night's 02:00 run, plant time
const P2_ROWS_UPDATED = Date.parse('2026-06-02T03:00:00Z'); // product P-2 got new unit_steps after that run
const FIRST_RUN = Date.parse('2026-06-02T05:58:00Z'); // 01:58 plant time, two minutes before tonight's run

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
    last_standards_recompute_at: new Date(PREVIOUS_FULL_RUN) as Date | null,
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
    if (text.startsWith('SELECT pg_notify')) return ok();
    unexpected.push(text);
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { handler, collector, unexpected };
}

/**
 * Starts a fresh collector at 01:58 plant time, optionally has a manager press "Recompute now" on
 * product P-1 (POST /api/portal/products/P-1/recompute -> NOTIFY fld_control), lets 02:00 pass and
 * returns the options of every StandardsRecomputer.run call.
 */
async function standardsRunsOverTheNight(opts: { managerRecomputesP1: boolean }): Promise<{ runs: StandardsRunOptions[]; unexpected: string[] }> {
  vi.resetModules();
  const db = scriptedDatabase();
  const runs: StandardsRunOptions[] = [];
  h.handler = db.handler;
  h.controlClients.length = 0;
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  process.env.DATABASE_URL = 'postgres://fld:fld@db.invalid:5432/fld';
  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'silent';

  vi.useFakeTimers({ now: FIRST_RUN, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    const { StandardsRecomputer } = await import('../src/engine/standards.js');
    vi.spyOn(StandardsRecomputer.prototype, 'run').mockImplementation(async (runOpts: StandardsRunOptions) => {
      runs.push(runOpts);
      return { pairs: 0, computed: 0, durationMs: 0 };
    });
    const { ODataSource } = await import('../src/sources/ODataSource.js');
    vi.spyOn(ODataSource.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(ODataSource.prototype, 'fetchPage').mockResolvedValue({ rows: [], nextLink: null } as never);

    await import('../src/index.js'); // starts the collector loop
    await vi.advanceTimersByTimeAsync(5_000); // first poll cycle; the loop now waits for the next one

    if (opts.managerRecomputesP1) {
      h.controlClients[0]?.emit('notification', { channel: 'fld_control', payload: JSON.stringify({ cmd: 'recompute_standards', product_number: 'P-1' }) });
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.advanceTimersByTimeAsync(3 * 60_000); // 02:00 plant time passes; the next poll cycle runs the nightly job

    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
  return { runs, unexpected: db.unexpected };
}

describe('nightly standards cutoff', () => {
  it('control: with no manual recompute the nightly job starts from the last full run', async () => {
    const { runs, unexpected } = await standardsRunsOverTheNight({ managerRecomputesP1: false });
    expect(unexpected).toEqual([]);
    expect(runs.map((r) => ({ product: r.productNumber ?? null, since: r.since }))).toEqual([{ product: null, since: PREVIOUS_FULL_RUN }]);
  });

  it('a product-scoped "Recompute now" does not hide other products\' new rows from the nightly job', async () => {
    const { runs, unexpected } = await standardsRunsOverTheNight({ managerRecomputesP1: true });
    expect(unexpected).toEqual([]);
    expect(runs.filter((r) => r.productNumber === 'P-1')).toHaveLength(1);
    const nightly = runs.find((r) => !r.productNumber);
    expect(nightly, 'the nightly standards run happened').toBeDefined();

    // P-2 received unit_steps at 03:00Z, after the last full run and before the P-1 click, and nothing has
    // recomputed it since. The nightly job must still include it: its cutoff may not be later than 03:00Z.
    expect(nightly?.since).not.toBeNull();
    expect(nightly?.since as number).toBeLessThanOrEqual(P2_ROWS_UPDATED);
    expect(nightly?.since).toBe(PREVIOUS_FULL_RUN);
  });
});
