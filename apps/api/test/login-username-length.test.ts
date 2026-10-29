import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';

/**
 * `loginSchema` only requires `min(1)` on both fields while every user name in the system is 2-60
 * characters, and the failed-login branch logs the submitted user name verbatim:
 *   req.log.warn({ username: body.username, ip: req.ip }, 'failed login')
 * nginx lets a request body of up to 1 MB through, so one unauthenticated request can put about 1 MB into
 * the api container log. docker-compose.yml sets no log rotation for the container, and the login limiter
 * can be sidestepped (X-Forwarded-For), so a loop fills the disk that also holds the database volume.
 */
const MAX_LOG_LINE_BYTES = 8 * 1024;

function ctx(lines: string[]): AppContext {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  const log = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
  return {
    env: { sessionSecret: 'k7Qm2vXz9LrT4pWc8NfYb3HsJd6AaEu5GxV1oRiBt0Zy' },
    db,
    pool: db,
    log,
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('POST /api/auth/login with an enormous user name', () => {
  it('does not write the whole thing to the log', async () => {
    const lines: string[] = [];
    app = await buildServer(ctx(lines));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'a'.repeat(900_000), password: 'x' }),
    });
    expect([400, 401]).toContain(res.statusCode);
    const longest = Math.max(0, ...lines.map((l) => Buffer.byteLength(l)));
    expect(longest).toBeLessThan(MAX_LOG_LINE_BYTES);
  });

  it('logs an ordinary failed login (baseline)', async () => {
    const lines: string[] = [];
    app = await buildServer(ctx(lines));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'alice', password: 'wrong-password' }),
    });
    expect(res.statusCode).toBe(401);
    expect(lines.some((l) => l.includes('failed login'))).toBe(true);
  });
});
