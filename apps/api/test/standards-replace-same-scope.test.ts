import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { registerAdminStandardsRoutes } from '../src/routes/admin/standards.js';
import { registerPortalRoutes } from '../src/routes/portal.js';

type Row = Record<string, unknown>;

/**
 * In-memory operations, standard_adjustments, standard_overrides and audit_log. Every insert gets a
 * created_at one hour after the previous one.
 */
function fakeDb() {
  const operations = new Map<string, number>([
    ['Weld', 1],
    ['Solder', 2],
  ]);
  const opName = (id: unknown) => [...operations].find(([, v]) => v === id)?.[0] ?? null;
  const adjustments: Row[] = [];
  const overrides: Row[] = [];
  const audits: { action: string; entity_id: string; before: Row | null; after: Row | null }[] = [];
  let clock = Date.parse('2025-06-09T08:00:00Z');

  const query = async (sql: string, params: unknown[] = []) => {
    const ok = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    const table = sql.includes('standard_adjustments') ? adjustments : overrides;
    if (/FROM operations WHERE name = \$1/.test(sql)) {
      const id = operations.get(params[0] as string);
      return ok(id === undefined ? [] : [{ id }]);
    }
    if (/INSERT INTO audit_log/.test(sql)) {
      const parse = (v: unknown) => (v === null ? null : (JSON.parse(v as string) as Row));
      audits.push({ action: params[1] as string, entity_id: params[3] as string, before: parse(params[4]), after: parse(params[5]) });
      return ok([]);
    }
    if (/INSERT INTO standard_(adjustments|overrides)/.test(sql)) {
      const [scope, product_number, operation_id, value, created_by, note] = params;
      const id = table.length + 1;
      const valueKey = table === adjustments ? 'percent' : 'std_hr';
      table.push({ id, scope, product_number, operation_id, [valueKey]: value, created_by, note, created_at: new Date((clock += 3_600_000)), active: true });
      return ok([{ id }]);
    }
    if (/UPDATE standard_(adjustments|overrides) SET active = false WHERE id = \$1 AND active/.test(sql)) {
      const hit = table.filter((r) => r.id === params[0] && r.active === true);
      for (const r of hit) r.active = false;
      return { rows: [], rowCount: hit.length };
    }
    if (/FROM standard_(adjustments a|overrides v)/.test(sql)) {
      let rows = table;
      if (/WHERE [av]\.id = \$1/.test(sql)) rows = rows.filter((r) => r.id === params[0]);
      if (/WHERE [av]\.active/.test(sql)) rows = rows.filter((r) => r.active === true);
      if (/v\.product_number = \$1/.test(sql)) rows = rows.filter((r) => r.product_number === params[0]);
      return ok(
        [...rows]
          .sort((a, b) => (b.created_at as Date).getTime() - (a.created_at as Date).getTime())
          .map((r) => ({ ...r, operation: opName(r.operation_id) })),
      );
    }
    return ok([]);
  };
  const active = (rows: Row[], key: 'percent' | 'std_hr') =>
    rows
      .filter((r) => r.active)
      .map((r) => `${r.scope} ${r.product_number ?? '-'} ${opName(r.operation_id) ?? '-'} ${r[key]}`)
      .sort();
  return {
    query,
    audits,
    activeAdjustments: () => active(adjustments, 'percent'),
    activeOverrides: () => active(overrides, 'std_hr'),
  };
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function app(db: ReturnType<typeof fakeDb>): Promise<FastifyInstance> {
  const s = Fastify();
  s.decorateRequest('auth', null);
  s.addHook('onRequest', async (req) => {
    req.auth = { id: 2, username: 'mgr', role: 'manager', active: true, created_at: 0, last_login_at: null };
  });
  s.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ message: err.message });
  });
  const ctx = { db, pool: db, log: { warn: () => undefined, error: () => undefined } } as unknown as AppContext;
  s.decorate('ctx', ctx);
  await registerPortalRoutes(s, ctx);
  await registerAdminStandardsRoutes(s, ctx);
  return s;
}

async function post(url: string, payload: Record<string, unknown>): Promise<Row> {
  const res = await server!.inject({ method: 'POST', url, payload: { note: 'n', ...payload } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Row;
}

describe('saving an adjustment or override replaces only the one on the same scope', () => {
  it('overrides: same product and operation is replaced (and audited); other operations, products and the product-wide one stay', async () => {
    const db = fakeDb();
    server = await app(db);
    const weld40 = await post('/api/portal/products/Z1/overrides', { scope: 'product_operation', product_number: 'Z1', operation: 'Weld', std_hr: 40 });
    await post('/api/portal/products/Z1/overrides', { scope: 'product_operation', product_number: 'Z1', operation: 'Solder', std_hr: 50 });
    const product20 = await post('/api/portal/products/Z1/overrides', { scope: 'product', product_number: 'Z1', std_hr: 20 });
    await post('/api/portal/products/Z2/overrides', { scope: 'product_operation', product_number: 'Z2', operation: 'Weld', std_hr: 44 });
    expect(db.audits.filter((a) => a.action === 'standards.override_replaced')).toEqual([]);

    const weld36 = await post('/api/portal/products/Z1/overrides', { scope: 'product_operation', product_number: 'Z1', operation: 'Weld', std_hr: 36 });
    await post('/api/portal/products/Z1/overrides', { scope: 'product', product_number: 'Z1', std_hr: 25 });

    expect(db.activeOverrides()).toEqual([
      'product Z1 - 25',
      'product_operation Z1 Solder 50',
      'product_operation Z1 Weld 36',
      'product_operation Z2 Weld 44',
    ]);
    const replaced = db.audits.filter((a) => a.action === 'standards.override_replaced');
    expect(replaced.map((a) => [a.entity_id, a.before?.std_hr, a.after?.std_hr])).toEqual([
      [String(weld40.id), 40, 36],
      [String(product20.id), 20, 25],
    ]);
    expect(replaced[0]!.after?.id).toBe(weld36.id);
  });

  it('adjustments: each of the four scopes replaces only its own, on the product page and in Admin > Standards', async () => {
    const db = fakeDb();
    server = await app(db);
    await post('/api/portal/products/Z1/adjustments', { scope: 'product', product_number: 'Z1', percent: 20 });
    await post('/api/portal/products/Z1/adjustments', { scope: 'product_operation', product_number: 'Z1', operation: 'Weld', percent: 5 });
    await post('/api/portal/products/Z1/adjustments', { scope: 'product_operation', product_number: 'Z1', operation: 'Solder', percent: 6 });
    await post('/api/portal/products/Z2/adjustments', { scope: 'product', product_number: 'Z2', percent: 7 });
    await post('/api/admin/standards/adjustments', { scope: 'global', percent: 10 });
    await post('/api/admin/standards/adjustments', { scope: 'operation', operation: 'Weld', percent: 15 });
    await post('/api/admin/standards/adjustments', { scope: 'operation', operation: 'Solder', percent: 16 });

    await post('/api/admin/standards/adjustments', { scope: 'global', percent: 12 });
    await post('/api/admin/standards/adjustments', { scope: 'operation', operation: 'Weld', percent: 14 });
    await post('/api/portal/products/Z1/adjustments', { scope: 'product', product_number: 'Z1', percent: 10 });
    await post('/api/portal/products/Z1/adjustments', { scope: 'product_operation', product_number: 'Z1', operation: 'Weld', percent: 4 });

    expect(db.activeAdjustments()).toEqual([
      'global - - 12',
      'operation - Solder 16',
      'operation - Weld 14',
      'product Z1 - 10',
      'product Z2 - 7',
      'product_operation Z1 Solder 6',
      'product_operation Z1 Weld 4',
    ]);
    expect(
      db.audits.filter((a) => a.action === 'standards.adjustment_replaced').map((a) => [a.before?.percent, a.after?.percent]),
    ).toEqual([
      [10, 12],
      [15, 14],
      [20, 10],
      [5, 4],
    ]);
  });
});
