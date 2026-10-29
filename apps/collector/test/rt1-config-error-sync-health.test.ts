/**
 * Red team: a `pg_dump` restored into an install with its own `.env` brings a FactoryLogix password
 * encrypted under the old ENCRYPTION_KEY. The collector cannot decrypt it, so it waits as if
 * nothing were configured. It only logged why: collector_state.last_error stayed empty, and
 * Admin > Sync and the "Data delayed" pill gave no reason. An invalid saved mapping and an
 * incomplete connection were just as quiet.
 *
 * This drives the real Collector (src/index.ts) with a scripted Postgres (the `pg` module is
 * replaced, as in rt1-standards-cutoff.test.ts), a fake clock and an OData source that returns
 * nothing, and reads what it writes to collector_state.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MappingConfig } from '@fld/shared';
import { encryptSecret } from '../src/crypto.js';

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

const THIS_KEY = 'ab'.repeat(32);
const OLD_INSTALL_KEY = 'cd'.repeat(32);
const NOW = Date.parse('2026-06-02T15:00:00Z'); // 11:00 plant time, far from the 02:00 standards job
const DUMPED_AT = NOW - 86_400_000;

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

const connectionSavedUnder = (key: string): Row => ({
  key: 'fl_connection',
  value: { base_url: 'http://factorylogix.invalid/odata', username: 'svc', password_enc: encryptSecret('the-real-password', key) },
});

/** The statements the collector issues here, answered from a restored database's state. */
function scriptedDatabase(saved: Row[]) {
  // The old install's collector_state comes along in the dump: it was polling fine.
  const collector = {
    heartbeat_at: new Date(DUMPED_AT) as Date | null,
    breaker_open_until: null as Date | null,
    status: 'ok',
    last_error: null as string | null,
    last_success_at: new Date(DUMPED_AT) as Date | null,
    consecutive_failures: 0,
    last_standards_recompute_at: null as Date | null,
  };
  let settings: Row[] = [
    { key: 'plant_timezone', value: 'America/New_York' },
    { key: 'poll_interval_seconds', value: 30 },
    { key: 'late_data_hours', value: 0 },
    { key: 'backfill_days', value: 0 },
    ...saved,
  ];
  const save = (row: Row) => {
    settings = [...settings.filter((r) => r.key !== row.key), row];
  };
  const syncState = new Map<string, Row>();
  const unexpected: string[] = [];
  let logId = 0;
  const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });

  const handler = (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return ok();
    if (text.startsWith('INSERT INTO collector_state')) return ok();
    if (text.includes('FROM collector_state WHERE id = 1')) return ok([{ ...collector }]);
    if (text.startsWith('UPDATE collector_state SET heartbeat_at')) {
      collector.status = params[1] as string;
      collector.last_error = params[2] as string | null;
      return ok([], 1);
    }
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
  return { handler, collector, save, unexpected };
}

/**
 * Starts the collector on a database holding `saved` and returns collector_state once it waits.
 * `fix` then runs what saving Admin > Connection does (the row, then NOTIFY fld_control restart),
 * and collector_state is read again after the next poll.
 */
async function syncHealth(saved: Row[], fix?: Row) {
  vi.resetModules();
  const db = scriptedDatabase(saved);
  h.handler = db.handler;
  h.controlClients.length = 0;
  process.env.ENCRYPTION_KEY = THIS_KEY;
  process.env.DATABASE_URL = 'postgres://fld:fld@db.invalid:5432/fld';
  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'silent';

  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  let waiting: { status: string; last_error: string | null };
  let afterFix: { status: string; last_error: string | null } | null = null;
  try {
    const { ODataSource } = await import('../src/sources/ODataSource.js');
    vi.spyOn(ODataSource.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(ODataSource.prototype, 'fetchPage').mockResolvedValue({ rows: [], nextLink: null } as never);

    await import('../src/index.js'); // starts the collector loop
    await vi.advanceTimersByTimeAsync(5_000); // it reads the settings and waits
    waiting = { status: db.collector.status, last_error: db.collector.last_error };

    if (fix) {
      db.save(fix);
      h.controlClients[0]?.emit('notification', { channel: 'fld_control', payload: JSON.stringify({ cmd: 'restart' }) });
      await vi.advanceTimersByTimeAsync(5_000);
      afterFix = { status: db.collector.status, last_error: db.collector.last_error };
    }

    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
  return { waiting, afterFix, unexpected: db.unexpected };
}

describe('Sync health while the collector cannot use what is saved', () => {
  it('says the restored password cannot be decrypted, and clears once it is typed again', async () => {
    const { waiting, afterFix, unexpected } = await syncHealth(
      [{ key: 'mapping', value: mapping }, connectionSavedUnder(OLD_INSTALL_KEY)],
      connectionSavedUnder(THIS_KEY),
    );
    expect(unexpected).toEqual([]);
    expect(waiting.last_error).toMatch(/could not decrypt the FactoryLogix password/);
    expect(waiting.last_error).toMatch(/enter the password again in Admin > Connection/);
    expect(afterFix).toEqual({ status: 'ok', last_error: null });
  });

  it('says the saved mapping is invalid', async () => {
    const { waiting, unexpected } = await syncHealth([
      { key: 'mapping', value: { ...mapping, unit_steps: { entity_set: 'UnitSteps' } } },
      connectionSavedUnder(THIS_KEY),
    ]);
    expect(unexpected).toEqual([]);
    expect(waiting.last_error).toMatch(/field mapping is invalid, fix it in Admin > Mapping: unit_steps/);
  });

  it('says the saved connection is incomplete', async () => {
    const { waiting, unexpected } = await syncHealth([
      { key: 'mapping', value: mapping },
      { key: 'fl_connection', value: { base_url: 'http://factorylogix.invalid/odata', username: 'svc', password_enc: null } },
    ]);
    expect(unexpected).toEqual([]);
    expect(waiting.last_error).toMatch(/FactoryLogix connection is incomplete/);
  });

  it('says the saved URL holds a user name or password, without repeating it, and clears once saved without them', async () => {
    const { waiting, afterFix, unexpected } = await syncHealth(
      [
        { key: 'mapping', value: mapping },
        {
          key: 'fl_connection',
          value: { base_url: 'http://svc:s3cretPass@factorylogix.invalid/odata', username: 'svc', password_enc: encryptSecret('the-real-password', THIS_KEY) },
        },
      ],
      connectionSavedUnder(THIS_KEY),
    );
    expect(unexpected).toEqual([]);
    expect(waiting.last_error).toMatch(/server URL must not contain a user name or password/);
    expect(waiting.last_error).not.toContain('s3cretPass');
    expect(afterFix).toEqual({ status: 'ok', last_error: null });
  });

  it('control: with nothing saved yet (the first-run wizard) no error is reported', async () => {
    const { waiting, unexpected } = await syncHealth([]);
    expect(unexpected).toEqual([]);
    expect(waiting).toEqual({ status: 'never', last_error: null });
  });
});
