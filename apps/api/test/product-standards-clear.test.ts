import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProductView, Role, StandardAdjustment, StandardOverride } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { registerPortalRoutes } from '../src/routes/portal.js';

/**
 * In-memory stand-in for the tables the product page reads and writes: operations, products,
 * product_routes, standards, standard_adjustments, standard_overrides (audit_log is ignored).
 * Every insert gets a created_at one hour after the previous one, like edits made over a day.
 */
function fakeDb() {
  const operations = new Map<string, number>([['Weld', 1]]);
  const opName = (id: number | null) => [...operations].find(([, v]) => v === id)?.[0] ?? null;
  const adjustments: Record<string, unknown>[] = [];
  const overrides: Record<string, unknown>[] = [];
  let clock = Date.parse('2025-06-09T08:00:00Z');
  const nextTs = () => new Date((clock += 3_600_000));

  const rowsOf = (table: Record<string, unknown>[], sql: string, params: unknown[]) => {
    let rows = table;
    if (/WHERE [av]\.id = \$1/.test(sql)) rows = rows.filter((r) => r.id === params[0]);
    if (/WHERE [av]\.active/.test(sql)) rows = rows.filter((r) => r.active === true);
    if (/v\.product_number = \$1/.test(sql)) rows = rows.filter((r) => r.product_number === params[0]);
    return [...rows]
      .sort((a, b) => (b.created_at as Date).getTime() - (a.created_at as Date).getTime() || (b.id as number) - (a.id as number))
      .map((r) => ({ ...r, operation: opName(r.operation_id as number | null) }));
  };

  const query = async (sql: string, params: unknown[] = []) => {
    const ok = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (/FROM operations WHERE name = \$1/.test(sql)) {
      const id = operations.get(params[0] as string);
      return ok(id === undefined ? [] : [{ id }]);
    }
    if (/INSERT INTO operations/.test(sql)) {
      const id = operations.get(params[0] as string) ?? operations.size + 1;
      operations.set(params[0] as string, id);
      return ok([{ id }]);
    }
    if (/INSERT INTO standard_(adjustments|overrides)/.test(sql)) {
      const table = sql.includes('standard_adjustments') ? adjustments : overrides;
      const [scope, product_number, operation_id, value, created_by, note] = params;
      const id = table.length + 1;
      table.push({
        id,
        scope,
        product_number,
        operation_id,
        ...(table === adjustments ? { percent: value } : { std_hr: value }),
        created_by,
        note,
        created_at: nextTs(),
        active: true,
      });
      return ok([{ id }]);
    }
    if (/UPDATE standard_(adjustments|overrides) SET active = false WHERE id = \$1 AND active/.test(sql)) {
      const table = sql.includes('standard_adjustments') ? adjustments : overrides;
      const hit = table.filter((r) => r.id === params[0] && r.active === true);
      for (const r of hit) r.active = false;
      return { rows: [], rowCount: hit.length };
    }
    if (/FROM standard_adjustments a/.test(sql)) return ok(rowsOf(adjustments, sql, params));
    if (/FROM standard_overrides v/.test(sql)) return ok(rowsOf(overrides, sql, params));
    if (/FROM products WHERE product_number = \$1/.test(sql)) {
      return ok([{ product_number: 'Z1', name: 'PCBA', first_seen_at: null, last_seen_at: null }]);
    }
    if (/FROM product_routes r/.test(sql)) return ok([{ product_number: 'Z1', operation: 'Weld' }]);
    if (/FROM standards s JOIN operations o/.test(sql)) {
      // Computed base standard for Z1 / Weld: 30 units per hour.
      return ok([
        {
          product_number: 'Z1',
          operation: 'Weld',
          computed_std_hr: 30,
          median_minutes_per_unit: 2,
          sample_units: 400,
          sample_operators: 5,
          sample_from: null,
          sample_to: null,
          computed_at: new Date('2025-06-09T06:00:00Z'),
          fallback_source: 'computed',
          fl_std_hr: null,
        },
      ]);
    }
    return ok([]);
  };
  return { query };
}

async function app(): Promise<FastifyInstance> {
  const server = Fastify();
  server.decorateRequest('auth', null);
  server.addHook('onRequest', async (req) => {
    const role = (req.headers['x-role'] as Role | undefined) ?? 'manager';
    req.auth = { id: 1, username: 'mgr', role, active: true, created_at: 0, last_login_at: null };
  });
  server.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ message: err.message });
  });
  const db = fakeDb();
  const ctx = { db, pool: db, log: { warn: () => undefined, error: () => undefined } } as unknown as AppContext;
  server.decorate('ctx', ctx);
  await registerPortalRoutes(server, ctx);
  return server;
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  server = server ?? (await app());
  const res = await server.inject({ method, url, payload: payload as Record<string, unknown> | undefined });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

const weld = async () => (await call<ProductView>('GET', '/api/portal/products/Z1')).rows.find((r) => r.operation === 'Weld')!;

describe('product page: changing an override or adjustment, then clearing it', () => {
  it('"Clear override" on a row whose override was changed once returns the row to its base StdHr', async () => {
    // Monday: the manager overrides Weld to 40 (row button "Override").
    await call<StandardOverride>('POST', '/api/portal/products/Z1/overrides', {
      scope: 'product_operation',
      product_number: 'Z1',
      operation: 'Weld',
      std_hr: 40,
      note: 'new fixture, slower for now',
    });
    // Tuesday: 40 was too low, they set it to 36 the same way.
    await call<StandardOverride>('POST', '/api/portal/products/Z1/overrides', {
      scope: 'product_operation',
      product_number: 'Z1',
      operation: 'Weld',
      std_hr: 36,
      note: 'adjusted after a day',
    });
    const before = await weld();
    expect(before.effective.effective).toBe(36);

    // Wednesday: the fixture issue is fixed, they press "Clear override" on the Weld row.
    await call('DELETE', `/api/portal/overrides/${before.effective.override!.id}`);

    const after = await weld();
    expect(after.effective.override).toBeNull();
    expect(after.effective.effective).toBe(30);
    expect(after.effective.provenance).toBe('base_computed');
  });

  it('"Clear" on a row whose product adjustment was changed once returns the row to its base StdHr', async () => {
    await call<StandardAdjustment>('POST', '/api/portal/products/Z1/adjustments', {
      scope: 'product',
      product_number: 'Z1',
      percent: 20,
      note: 'trainees on the line',
    });
    await call<StandardAdjustment>('POST', '/api/portal/products/Z1/adjustments', {
      scope: 'product',
      product_number: 'Z1',
      percent: 10,
      note: 'trainees mostly up to speed',
    });
    const before = await weld();
    expect(before.effective.effective).toBe(33);

    await call('DELETE', `/api/portal/adjustments/${before.effective.adjustment!.id}`);

    const after = await weld();
    expect(after.effective.adjustment).toBeNull();
    expect(after.effective.effective).toBe(30);
  });
});
