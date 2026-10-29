/**
 * Red team: FactoryLogix refusing the saved login (the service account's password was changed in
 * FactoryLogix, or the account was locked or disabled) was retried like any other failure: on the
 * breaker schedule (90 s, then every 10 minutes, for good), again after every settings, shift or
 * break edit (each sends `restart`), and every 5 s by an active backfill. A refused login does not
 * heal by itself, and every retry is one more failed login, which a lockout policy counts against
 * the account.
 *
 * This drives the real Collector (src/index.ts) with a scripted Postgres (the `pg` module is
 * replaced, as in rt1-config-error-sync-health.test.ts), a fake clock and a FactoryLogix stub (the
 * global fetch) that answers 401 to every password but the one it currently has.
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

const KEY = 'ab'.repeat(32);
const SAVED_PASSWORD = 'the-saved-password';
const MINUTE = 60_000;
const DAY_SHIFT = Date.parse('2026-06-02T15:00:00Z'); // 11:00 plant time
const NIGHT = Date.parse('2026-06-03T03:00:00Z'); // 23:00 plant time, inside the 22:00-05:00 backfill window

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

const connection = (password: string) => ({
  base_url: 'http://factorylogix.invalid/odata',
  username: 'svc',
  password_enc: encryptSecret(password, KEY),
});

/** FactoryLogix's OData service: 401 for any password but `password`, no rows otherwise. */
function factoryLogix() {
  const fl = {
    password: SAVED_PASSWORD,
    requests: [] as { at: number; path: string; refused: boolean }[],
  };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const refused = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8') !== `svc:${fl.password}`;
    const path = new URL(input).pathname.replace(/^\/odata\//, '');
    fl.requests.push({ at: Date.now(), path, refused });
    if (refused) return new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' });
    if (path === '$metadata') return new Response('', { status: 404, statusText: 'Not Found' });
    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fl, fetch };
}

/** The statements the collector issues here, answered from small in-memory state. */
function scriptedDatabase(start: number, backfillDays: number) {
  const collector = {
    heartbeat_at: null as Date | null,
    breaker_open_until: null as Date | null,
    status: 'never',
    last_error: null as string | null,
    last_success_at: null as Date | null,
    consecutive_failures: 0,
    last_standards_recompute_at: new Date(start - 3_600_000) as Date | null,
  };
  // Like the real table, every row says when it was last saved.
  let settings: Row[] = [
    { key: 'plant_timezone', value: 'America/New_York' },
    { key: 'late_data_hours', value: 0 },
    { key: 'backfill_days', value: backfillDays },
    { key: 'mapping', value: mapping },
    { key: 'fl_connection', value: connection(SAVED_PASSWORD) },
  ].map((row) => ({ ...row, updated_at: new Date(start - 86_400_000) }));
  /**
   * What the api's save does (`setSettingValue`): the row, with `updated_at = now()`. Without a
   * value, the row is saved unchanged (Admin > Connection saved with the password left blank).
   */
  const save = (key: string, value: unknown = settings.find((r) => r.key === key)?.value) => {
    settings = [...settings.filter((r) => r.key !== key), { key, value, updated_at: new Date(Date.now()) }];
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
      const [openUntil, status, lastError, lastSuccessAt, failures] = params as [Date | null, string, string | null, Date | null, number];
      Object.assign(collector, {
        heartbeat_at: new Date(Date.now()),
        breaker_open_until: openUntil,
        status,
        last_error: lastError,
        last_success_at: lastSuccessAt,
        consecutive_failures: failures,
      });
      return ok([], 1);
    }
    if (text.startsWith('UPDATE collector_state SET last_standards_recompute_at')) return ok([], 1);
    if (text === 'SELECT key, value FROM settings') return ok(settings.map(({ key, value }) => ({ key, value })));
    const oneSetting = /^SELECT [\w, ]+ FROM settings WHERE key = (?:\$1|'(\w+)')$/.exec(text);
    if (oneSetting) {
      const key = oneSetting[1] ?? params[0];
      return ok(settings.filter((r) => r.key === key).map((r) => ({ ...r, updated_by: 'admin' })));
    }
    if (text === 'SELECT id, name FROM operations') return ok();
    if (text.includes('FROM sync_state WHERE source')) {
      const found = syncState.get(params[0] as string);
      return ok(found ? [{ ...found }] : []);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_success_at')) {
      const [source, watermark] = params as [string, string | null];
      const previous = syncState.get(source) ?? {};
      syncState.set(source, { source, ...previous, consecutive_failures: 0, last_error: null, watermark: watermark ?? previous.watermark ?? null });
      return ok([], 1);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_error')) {
      const [source, error] = params as [string, string];
      const previous = syncState.get(source) ?? { watermark: null, consecutive_failures: 0 };
      syncState.set(source, { source, ...previous, last_error: error, consecutive_failures: Number(previous.consecutive_failures ?? 0) + 1 });
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

/** Runs `script` against a real collector started at `start`, then stops it. */
async function withCollector(
  opts: { start: number; backfillDays: number },
  script: (env: {
    fl: ReturnType<typeof factoryLogix>['fl'];
    db: ReturnType<typeof scriptedDatabase>;
    advance: (ms: number) => Promise<unknown>;
    /** NOTIFY fld_control restart: what the api sends after any admin save (settings, shifts, breaks, connection). */
    restart: () => void;
  }) => Promise<void>,
): Promise<void> {
  vi.resetModules();
  const { fl, fetch } = factoryLogix();
  const db = scriptedDatabase(opts.start, opts.backfillDays);
  h.handler = db.handler;
  h.controlClients.length = 0;
  process.env.ENCRYPTION_KEY = KEY;
  process.env.DATABASE_URL = 'postgres://fld:fld@db.invalid:5432/fld';
  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'silent';

  vi.useFakeTimers({ now: opts.start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.stubGlobal('fetch', fetch);
  try {
    await import('../src/index.js'); // starts the collector loop
    await vi.advanceTimersByTimeAsync(1_000);
    await script({
      fl,
      db,
      advance: (ms) => vi.advanceTimersByTimeAsync(ms),
      restart: () => h.controlClients[0]?.emit('notification', { channel: 'fld_control', payload: JSON.stringify({ cmd: 'restart' }) }),
    });
    expect(db.unexpected).toEqual([]);
  } finally {
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
}

const refusedSince = (fl: ReturnType<typeof factoryLogix>['fl'], at: number) => fl.requests.filter((r) => r.refused && r.at >= at);

describe('FactoryLogix refusing the saved login', () => {
  it('control: polls go through on the poll interval while the login is accepted', async () => {
    await withCollector({ start: DAY_SHIFT, backfillDays: 0 }, async ({ fl, db, advance }) => {
      await advance(10 * MINUTE);
      expect(fl.requests.filter((r) => r.path === 'WorkOrders').length).toBeGreaterThanOrEqual(6);
      expect(fl.requests.filter((r) => r.refused)).toEqual([]);
      expect(db.collector.status).toBe('ok');
    });
  });

  it('is not retried on the breaker schedule or after settings edits, and Sync health says why polling stopped', async () => {
    await withCollector({ start: DAY_SHIFT, backfillDays: 0 }, async ({ fl, db, advance, restart }) => {
      await advance(30_000);
      fl.password = 'changed-in-factorylogix'; // the service account's password is changed; the next poll is refused
      await advance(2 * MINUTE);
      const firstRefusal = refusedSince(fl, DAY_SHIFT);
      expect(firstRefusal).toHaveLength(1);
      const stoppedAt = firstRefusal[0]?.at as number;

      // Two hours of breaker schedule, three admin edits elsewhere (settings, shifts, breaks).
      for (const wait of [10, 10, 20, 80]) {
        await advance(wait * MINUTE);
        restart();
        await advance(5_000);
      }
      expect(fl.requests.filter((r) => r.at > stoppedAt), 'requests sent after FactoryLogix refused the login').toEqual([]);

      expect(db.collector.status).toBe('down');
      expect(db.collector.last_error).toMatch(/refused/i);
      expect(db.collector.last_error).toContain('HTTP 401');
      expect(db.collector.last_error).toMatch(/save .*Admin > Connection|Admin > Connection.* save/i);
    });
  });

  it('polls again once Admin > Connection is saved again, even with the password left blank', async () => {
    await withCollector({ start: DAY_SHIFT, backfillDays: 0 }, async ({ fl, db, advance, restart }) => {
      await advance(30_000);
      fl.password = 'locked'; // the account is locked: every login is refused
      await advance(60 * MINUTE);
      expect(refusedSince(fl, DAY_SHIFT)).toHaveLength(1);

      // A FactoryLogix admin unlocks the account; a dashboard admin saves Admin > Connection
      // unchanged (a blank password keeps the saved one), which sends restart.
      fl.password = SAVED_PASSWORD;
      const savedAt = Date.now();
      db.save('fl_connection');
      restart();
      await advance(5_000);
      expect(fl.requests.filter((r) => r.at >= savedAt && r.path === 'WorkOrders' && !r.refused)).toHaveLength(1);
      expect(db.collector.status).toBe('ok');
      expect(db.collector.last_error).toBeNull();
    });
  });

  it('polls again once a new password is saved, even when the restart notification is lost', async () => {
    await withCollector({ start: DAY_SHIFT, backfillDays: 0 }, async ({ fl, db, advance }) => {
      await advance(30_000);
      fl.password = 'changed-in-factorylogix';
      await advance(60 * MINUTE);
      expect(refusedSince(fl, DAY_SHIFT)).toHaveLength(1);

      const savedAt = Date.now();
      db.save('fl_connection', connection('changed-in-factorylogix'));
      await advance(MINUTE);
      expect(fl.requests.filter((r) => r.at >= savedAt && r.path === 'WorkOrders' && !r.refused).length).toBeGreaterThanOrEqual(1);
      expect(refusedSince(fl, savedAt)).toEqual([]);
      expect(db.collector.status).toBe('ok');
    });
  });

  it('an active backfill does not retry it every few seconds', async () => {
    await withCollector({ start: NIGHT, backfillDays: 30 }, async ({ fl, advance }) => {
      await advance(11_000); // the backfill downloads its first days between polls
      expect(fl.requests.filter((r) => r.path === 'UnitSteps').length).toBeGreaterThan(1);
      fl.password = 'changed-in-factorylogix';
      await advance(30 * MINUTE);
      // At most the backfill chunk that ran into it and the next poll.
      expect(refusedSince(fl, NIGHT).length).toBeLessThanOrEqual(2);
    });
  });
});
