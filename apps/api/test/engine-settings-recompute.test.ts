import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { registerAdminSettingsRoutes } from '../src/routes/admin/settings.js';

type Control = { cmd: string; from_utc?: number; to_utc?: number };

/** settings table that accepts writes, plus the NOTIFY messages sent on the collector control channel. */
function fakeDb() {
  const notified: Control[] = [];
  const ok = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.includes('pg_notify')) {
        notified.push(JSON.parse(params[1] as string) as Control);
        return ok();
      }
      if (q.startsWith('SELECT key, value FROM settings')) return ok();
      if (q.startsWith('INSERT INTO settings') || q.startsWith('INSERT INTO audit_log')) return ok();
      throw new Error(`fake db: unexpected SQL ${q}`);
    },
  };
  return { db, notified };
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function appFor(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { id: 1, username: 'admin', role: 'admin' as Role, active: true, created_at: 0, last_login_at: null };
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ message: err.message });
  });
  const ctx = { db, pool: db, log: { warn: () => undefined, error: () => undefined }, sse: { broadcast: () => undefined } } as unknown as AppContext;
  app.decorate('ctx', ctx);
  await registerAdminSettingsRoutes(app, ctx);
  server = app;
  return app;
}

describe('saving engine settings (EnginePage: "Hour cells are recomputed on the next refresh")', () => {
  it.each([
    ['color_yellow_below', 0.8],
    ['count_work_during_breaks', true],
    ['eligibility_minutes', 20],
  ])('asks the collector to recompute the cells that %s changes (docs/API.md: the API sends recompute_cells)', async (key, value) => {
    const store = fakeDb();
    const app = await appFor(store.db);
    const before = Date.now();

    const res = await app.inject({ method: 'PATCH', url: '/api/admin/settings', payload: { [key]: value } });
    expect(res.statusCode).toBe(200);

    // The collector only recomputes the current and previous hour by itself, and 'restart' just reloads config.
    // The TV shows 12 hours of stored cells, so at least those must be recomputed with the new setting.
    const recompute = store.notified.find((c) => c.cmd === 'recompute_cells');
    expect(recompute).toBeDefined();
    expect(recompute?.to_utc ?? 0).toBeGreaterThanOrEqual(before);
    expect(recompute?.from_utc ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(before - 12 * 3_600_000);
  });
});
