import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { registerPortalRoutes } from '../src/routes/portal.js';

/** One active adjustment of each scope. Only the product ones belong to a product page. */
function fakeDb() {
  const adjustments: Record<string, unknown>[] = [
    { id: 1, scope: 'global', product_number: null, operation: null },
    { id: 2, scope: 'operation', product_number: null, operation: 'Weld' },
    { id: 3, scope: 'product', product_number: 'Z1', operation: null },
    { id: 4, scope: 'product_operation', product_number: 'Z1', operation: 'Weld' },
  ].map((a) => ({ ...a, percent: 10, created_by: 'admin', created_at: new Date('2025-06-01T12:00:00Z'), note: 'n', active: true }));
  const query = async (sql: string, params: unknown[] = []) => {
    if (/FROM standard_adjustments a/.test(sql) && /WHERE a\.id = \$1/.test(sql)) {
      const rows = adjustments.filter((r) => r.id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (/UPDATE standard_adjustments SET active = false WHERE id = \$1 AND active/.test(sql)) {
      const hit = adjustments.filter((r) => r.id === params[0] && r.active === true);
      for (const r of hit) r.active = false;
      return { rows: [], rowCount: hit.length };
    }
    return { rows: [], rowCount: 0 }; // audit_log
  };
  return { adjustments, query };
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
  return s;
}

describe('DELETE /api/portal/adjustments/:id (the product page "Clear" and "Remove")', () => {
  it.each([
    [1, 'global', 400, true],
    [2, 'operation', 400, true],
    [3, 'product', 200, false],
    [4, 'product_operation', 200, false],
  ])('adjustment %i (%s scope) answers %i', async (id, _scope, status, stillActive) => {
    const db = fakeDb();
    server = await app(db);
    const res = await server.inject({ method: 'DELETE', url: `/api/portal/adjustments/${id}` });
    expect(res.statusCode).toBe(status);
    if (status === 400) expect(res.json().message).toContain('/api/admin/standards/adjustments/:id');
    expect(db.adjustments.find((a) => a.id === id)?.active).toBe(stillActive);
  });
});
