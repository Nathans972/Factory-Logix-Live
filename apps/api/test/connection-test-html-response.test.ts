import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { registerAdminSettingsRoutes } from '../src/routes/admin/settings.js';

/**
 * The FactoryLogix address typed in the wizard answers 200 with an HTML page instead of EDMX: a
 * single-sign-on login page, an IIS default or error page, a reverse proxy's landing page. "Test
 * connection" must not call that a working OData service.
 */
const LOGIN_PAGE =
  '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form action="/login" method="post">' +
  '<input name="user"><input name="password" type="password"></form></body></html>';

let fake: http.Server;
let baseUrl = '';
let server: FastifyInstance;
const queries: { sql: string; params: unknown[] }[] = [];

beforeAll(async () => {
  fake = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/odata`;

  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const ctx = { db, pool: db, log: { warn: () => undefined, error: () => undefined }, sse: { broadcast: () => undefined } } as unknown as AppContext;
  server = Fastify();
  server.decorate('ctx', ctx);
  server.decorateRequest('auth', null);
  server.addHook('onRequest', async (req) => {
    req.auth = { id: 1, username: 'admin', role: 'admin', active: true, created_at: 0, last_login_at: null };
  });
  await registerAdminSettingsRoutes(server, ctx);
});

afterAll(async () => {
  await server.close();
  fake.close();
});

describe('POST /api/admin/connection/test against a server that answers 200 with an HTML page', () => {
  it('does not report the HTML page as a working connection', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/admin/connection/test',
      payload: { base_url: baseUrl, username: 'svc', password: 'secret' },
    });
    const body = res.json() as { ok: boolean; error: string | null };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it('does not replace the cached $metadata with an empty document', async () => {
    queries.length = 0;
    await server.inject({
      method: 'POST',
      url: '/api/admin/connection/test',
      payload: { base_url: baseUrl, username: 'svc', password: 'secret' },
    });
    const cached = queries.filter((q) => q.sql.includes('INSERT INTO settings') && q.params[0] === 'odata_metadata');
    expect(cached).toEqual([]);
  });
});
