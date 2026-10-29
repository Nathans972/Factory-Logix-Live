import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context.js';

const hashPassword = vi.hoisted(() => vi.fn(async (p: string) => `hash-of-${p}`));
vi.mock('../src/auth/password.js', () => ({ hashPassword, verifyPassword: async () => false }));

const { buildServer } = await import('../src/server.js');

/** A `users` table of `initial` rows behind the count and the guarded INSERT … WHERE NOT EXISTS. */
function ctxWithUsers(initial: number): AppContext {
  let users = initial;
  const query = async (text: string, values: unknown[] = []) => {
    if (/INSERT INTO users/i.test(text)) {
      if (users > 0) return { rows: [], rowCount: 0 };
      users += 1;
      const row = { id: users, username: values[0], role: 'admin', active: true, created_at: new Date(), last_login_at: null };
      return { rows: [row], rowCount: 1 };
    }
    if (/count\(\*\)/i.test(text)) return { rows: [{ n: users }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client };
  return {
    env: { sessionSecret: 'a-very-long-test-session-secret-value' },
    db: pool,
    pool,
    log: pino({ level: 'silent' }),
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext;
}

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
  hashPassword.mockClear();
});

async function server(initialUsers: number): Promise<FastifyInstance> {
  const app = await buildServer(ctxWithUsers(initialUsers));
  closers.push(() => app.close());
  return app;
}

async function setup(app: FastifyInstance, remoteAddress: string, username: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/setup/admin',
    remoteAddress,
    payload: { username, password: 'correct-horse' },
  });
  return res.statusCode;
}

describe('POST /api/setup/admin', () => {
  it('creates the first admin and logs them in while no user exists', async () => {
    const app = await server(0);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { username: 'admin', password: 'correct-horse' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'admin', role: 'admin' });
    expect(String(res.headers['set-cookie'])).toContain('fld_session=');
    expect(hashPassword).toHaveBeenCalledTimes(1);

    // Setup is now done: the next request is refused before its password is hashed.
    expect(await setup(app, '10.0.0.20', 'second')).toBe(409);
    expect(hashPassword).toHaveBeenCalledTimes(1);
  });

  it('refuses a client after 10 requests a minute, and only that client', async () => {
    const app = await server(1);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push(await setup(app, '10.0.0.66', `intruder${i}`));
    expect(statuses).toEqual([...Array<number>(10).fill(409), 429, 429]);
    expect(await setup(app, '10.0.0.20', 'admin')).toBe(409);
  });
});
