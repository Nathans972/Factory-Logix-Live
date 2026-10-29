import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { registerAdminSettingsRoutes } from '../src/routes/admin/settings.js';

/**
 * An admin pastes the address the way a browser or curl takes it, with the account in front:
 * `http://svc:s3cretPass@fl.example:6065/odata`. The URL schema accepts it and the form never checks it.
 * The password then lives in `base_url`, which is stored and audited in clear text (the `password` field
 * is the only thing encrypted), and fetch refuses such a URL with an error that repeats it in full.
 * Whatever the fix is (reject the URL, or move the credentials into the password field), the clear text
 * password must not end up in the database or in a response.
 */
const SECRET = 's3cretPass';
const URL_WITH_CREDENTIALS = `http://svc:${SECRET}@127.0.0.1:9/odata`;

let server: FastifyInstance;
const writes: { sql: string; params: unknown[] }[] = [];
const previousKey = process.env.ENCRYPTION_KEY;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^\s*(INSERT|UPDATE)/i.test(sql) || sql.includes('pg_notify')) writes.push({ sql, params });
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
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousKey;
});

beforeEach(() => {
  writes.length = 0;
});

const leakedInWrites = (): boolean => writes.some((w) => JSON.stringify(w.params).includes(SECRET));

describe('FactoryLogix address with the password typed into the URL', () => {
  it('saving the connection does not store the password in clear text (settings row or audit log)', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/admin/connection',
      payload: { base_url: URL_WITH_CREDENTIALS, username: 'svc' },
    });
    // Rejecting the URL (400) or moving the credentials out of it are both fine; storing it as typed is not.
    expect(res.statusCode === 400 || !leakedInWrites(), `status ${res.statusCode}; password in a database write: ${leakedInWrites()}`).toBe(true);
  });

  it('testing the connection does not echo the password in the response or write it to the audit log', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/admin/connection/test',
      payload: { base_url: URL_WITH_CREDENTIALS, username: 'svc', password: 'real-password' },
    });
    expect(res.body).not.toContain(SECRET);
    expect(leakedInWrites(), 'password in a database write').toBe(false);
  });
});
