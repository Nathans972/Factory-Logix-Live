import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProductView } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { registerPortalRoutes } from '../src/routes/portal.js';

/**
 * In-memory products Z1 and Z2, both with a Weld standard computed at 30/h, and one plant-wide
 * adjustment of +10% that an admin created in Admin > Standards (scope 'global').
 */
function fakeDb() {
  const adjustments: Record<string, unknown>[] = [
    {
      id: 1, scope: 'global', product_number: null, operation_id: null, percent: 10, created_by: 'admin',
      created_at: new Date('2025-06-01T12:00:00Z'), note: 'new-hire month', active: true,
    },
  ];
  const query = async (sql: string, params: unknown[] = []) => {
    const ok = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
    if (/FROM standard_adjustments a/.test(sql)) {
      let rows = adjustments;
      if (/WHERE a\.id = \$1/.test(sql)) rows = rows.filter((r) => r.id === params[0]);
      if (/WHERE a\.active/.test(sql)) rows = rows.filter((r) => r.active === true);
      return ok(rows.map((r) => ({ ...r, operation: null })));
    }
    if (/UPDATE standard_adjustments SET active = false WHERE id = \$1 AND active/.test(sql)) {
      const hit = adjustments.filter((r) => r.id === params[0] && r.active === true);
      for (const r of hit) r.active = false;
      return ok([], hit.length);
    }
    if (/FROM products WHERE product_number = \$1/.test(sql)) {
      return ok([{ product_number: params[0], name: null, first_seen_at: null, last_seen_at: null }]);
    }
    if (/FROM product_routes r/.test(sql)) {
      return ok((params[0] as string[]).map((p) => ({ product_number: p, operation: 'Weld' })));
    }
    if (/FROM standards s JOIN operations o/.test(sql)) {
      return ok([
        {
          product_number: params[0], operation: 'Weld', computed_std_hr: 30, median_minutes_per_unit: 2,
          sample_units: 400, sample_operators: 5, sample_from: null, sample_to: null,
          computed_at: new Date('2025-06-09T06:00:00Z'), fallback_source: 'computed', fl_std_hr: null,
        },
      ]);
    }
    return ok([]); // overrides, audit_log
  };
  return { query };
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function app(): Promise<FastifyInstance> {
  const s = Fastify();
  s.decorateRequest('auth', null);
  s.addHook('onRequest', async (req) => {
    req.auth = { id: 2, username: 'mgr', role: 'manager', active: true, created_at: 0, last_login_at: null };
  });
  s.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ message: err.message });
  });
  const db = fakeDb();
  const ctx = { db, pool: db, log: { warn: () => undefined, error: () => undefined } } as unknown as AppContext;
  s.decorate('ctx', ctx);
  await registerPortalRoutes(s, ctx);
  return s;
}

async function weld(product: string) {
  const res = await server!.inject({ method: 'GET', url: `/api/portal/products/${product}` });
  expect(res.statusCode).toBe(200);
  return (res.json() as ProductView).rows.find((r) => r.operation === 'Weld')!;
}

describe('product page "Clear" on a row whose adjustment is the plant-wide one', () => {
  it('does not remove the adjustment from every other product', async () => {
    server = await app();

    // A manager on Z1's product page sees "+10%" on the Weld row and presses its "Clear" button
    // (ProductPage.tsx: ds.deleteAdjustment(r.effective.adjustment.id), no confirmation).
    const z1 = await weld('Z1');
    expect(z1.effective.adjustment).toMatchObject({ id: 1, scope: 'global' });
    expect(z1.effective.effective).toBe(33);
    await server.inject({ method: 'DELETE', url: `/api/portal/adjustments/${z1.effective.adjustment!.id}` });

    // The portal's own create route refuses global scope ("use /api/admin/standards/adjustments"),
    // so a product-page action should not be able to change Z2's standard either.
    const z2 = await weld('Z2');
    expect(z2.effective.adjustment?.id).toBe(1);
    expect(z2.effective.effective).toBe(33);
  });
});
