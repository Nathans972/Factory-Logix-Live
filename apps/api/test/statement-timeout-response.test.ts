import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';

/** A database that cancels every statement the way Postgres reports a statement timeout. */
function ctxTimingOut(): AppContext {
  const query = async () => {
    throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
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
});

describe('a request whose statement hits the statement timeout', () => {
  it('answers 503 saying the database took too long, not "internal server error"', async () => {
    app = await buildServer(ctxTimingOut());
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'unavailable', message: 'the database took too long to answer', statusCode: 503 });
  });
});
