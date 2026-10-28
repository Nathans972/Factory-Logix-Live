import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { EXAMPLE_MAPPING } from '@fld/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signSession } from '../src/auth/session.js';
import type { AppContext } from '../src/context.js';
import { encrypt } from '../src/crypto.js';
import { buildServer } from '../src/server.js';

/**
 * docs/OPERATIONS.md restores a `pg_dump` into an install that has its own `.env`. `ENCRYPTION_KEY` is
 * not part of the dump, so the restored `fl_connection.password_enc` was written with another key
 * and cannot be decrypted. The admin must be told to type the FactoryLogix password again; today the
 * connection test, the $metadata refresh and the preview all answer 500 "internal server error".
 */
const OLD_KEY = randomBytes(32).toString('hex');
const NEW_KEY = randomBytes(32).toString('hex');
const SESSION_SECRET = 'a-very-long-test-session-secret-value';

let server: FastifyInstance;
let cookie = '';
const previousKey = process.env.ENCRYPTION_KEY;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = NEW_KEY;
  const restoredConnection = {
    base_url: 'http://127.0.0.1:1/odata',
    username: 'svc',
    password_enc: encrypt('the-real-password', OLD_KEY),
  };
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM users WHERE id')) {
        return { rows: [{ id: 1, username: 'admin', role: 'admin', active: true, created_at: new Date(0), last_login_at: null }], rowCount: 1 };
      }
      if (sql.includes('WHERE key = $1')) {
        return params[0] === 'fl_connection'
          ? { rows: [{ key: 'fl_connection', value: restoredConnection }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const ctx = {
    env: { sessionSecret: SESSION_SECRET },
    db,
    pool: db,
    log: pino({ level: 'silent' }),
    sse: { broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext;
  server = await buildServer(ctx);
  cookie = `${SESSION_COOKIE}=${await signSession({ userId: 1, role: 'admin' }, SESSION_SECRET)}`;
});

afterAll(async () => {
  await server.close();
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousKey;
});

describe('stored FactoryLogix password that the current ENCRYPTION_KEY cannot decrypt', () => {
  it('connection test answers with a readable error, not a 500', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/admin/connection/test', headers: { cookie }, payload: {} });
    expect(res.statusCode, res.body).toBeLessThan(500);
    const body = res.json() as { ok?: boolean; error?: string | null; message?: string };
    expect(`${body.error ?? ''} ${body.message ?? ''}`).toMatch(/password|ENCRYPTION_KEY|decrypt/i);
  });

  it('mapping preview answers with a readable error, not a 500', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/admin/mapping/preview',
      headers: { cookie },
      payload: { dataset: 'work_orders', mapping: { work_orders: EXAMPLE_MAPPING.work_orders } },
    });
    expect(res.statusCode, res.body).toBeLessThan(500);
  });
});
