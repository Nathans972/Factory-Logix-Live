import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context.js';

const hashPassword = vi.hoisted(() => vi.fn(async (p: string) => `hash-of-${p}`));
vi.mock('../src/auth/password.js', () => ({ hashPassword, verifyPassword: async () => false }));

const { buildServer } = await import('../src/server.js');

/**
 * A database where setup is finished: `users` has a row, so the guarded INSERT inserts nothing.
 * Every query that counts users answers 1; the INSERT … WHERE NOT EXISTS returns no row.
 */
function ctxWithUsers(): AppContext {
  const query = async (text: string) => {
    if (/INSERT INTO users/i.test(text)) return { rows: [], rowCount: 0 };
    if (/count\(\*\)/i.test(text)) return { rows: [{ n: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client };
  return {
    env: { sessionSecret: 'k7Qm2vXz9LrT4pWc8NfYb3HsJd6AaEu5GxV1oRiBt0Zy' },
    db: pool,
    pool,
    log: pino({ level: 'silent' }),
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  hashPassword.mockClear();
});

describe('POST /api/setup/admin once an admin exists', () => {
  it('answers 409 (baseline)', async () => {
    app = await buildServer(ctxWithUsers());
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'intruder', password: 'correct-horse' }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('does not run the password hash for an unauthenticated caller', async () => {
    app = await buildServer(ctxWithUsers());
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username: `intruder${i}`, password: 'correct-horse' }),
      });
      expect(res.statusCode).toBe(409);
    }
    // Each call to the real hashPassword is an argon2id hash (64 MiB, 3 passes) on the libuv thread pool.
    expect(hashPassword).not.toHaveBeenCalled();
  });
});
