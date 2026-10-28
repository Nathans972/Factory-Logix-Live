import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { registerAdminOpsRoutes } from '../src/routes/admin/ops.js';

/** The ops routes with `req.auth` taken from an `x-role` header and a database that returns no rows. */
async function app(): Promise<FastifyInstance> {
  const server = Fastify();
  server.decorateRequest('auth', null);
  server.addHook('onRequest', async (req) => {
    const role = req.headers['x-role'] as Role | undefined;
    req.auth = role ? { id: 1, username: role, role, active: true, created_at: 0, last_login_at: null } : null;
  });
  server.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ message: err.message });
  });
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  await registerAdminOpsRoutes(server, { db, pool: db, log: { warn: () => undefined } } as unknown as AppContext);
  return server;
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function status(method: 'GET' | 'POST', url: string, role?: Role): Promise<number> {
  server = server ?? (await app());
  const res = await server.inject({ method, url, headers: role ? { 'x-role': role } : {} });
  return res.statusCode;
}

describe('admin ops routes', () => {
  it('lets managers and admins read the sync log, not viewers', async () => {
    expect(await status('GET', '/api/admin/sync/log', 'manager')).toBe(200);
    expect(await status('GET', '/api/admin/sync/log', 'admin')).toBe(200);
    expect(await status('GET', '/api/admin/sync/log', 'viewer')).toBe(403);
    expect(await status('GET', '/api/admin/sync/log')).toBe(401);
  });

  it('keeps the backfill action and the audit log admin-only', async () => {
    expect(await status('POST', '/api/admin/backfill/run', 'manager')).toBe(403);
    expect(await status('GET', '/api/admin/audit', 'manager')).toBe(403);
    expect(await status('GET', '/api/admin/sync', 'manager')).toBe(403);
  });
});
