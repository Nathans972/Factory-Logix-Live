import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';
import { SseHub } from '../src/sse.js';

/** No user exists, so every login is a plain 401 (no password hashing involved). */
const db = { query: async () => ({ rows: [], rowCount: 0 }) };

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

async function server() {
  const log = pino({ level: 'silent' });
  const ctx = {
    env: { sessionSecret: 'a-very-long-test-session-secret-value' },
    pool: db,
    db,
    log,
    sse: new SseHub('postgres://unused', log),
    version: 'test',
  } as unknown as AppContext;
  const app = await buildServer(ctx);
  closers.push(() => app.close());
  return app;
}

// docker-compose: browser -> nginx (apps/web/nginx.conf) -> api. nginx sets
//   X-Forwarded-For: $proxy_add_x_forwarded_for
// which appends the real peer to whatever the client sent, so the api receives
// "<whatever the client wrote>, <real client address>" from the nginx container.
const NGINX = '172.18.0.3';
const REAL_CLIENT = '10.0.0.66';

async function loginStatuses(forwardedFor: (i: number) => string): Promise<number[]> {
  const app = await server();
  const statuses: number[] = [];
  for (let i = 0; i < 25; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: NGINX,
      headers: { 'x-forwarded-for': forwardedFor(i) },
      payload: { username: 'admin', password: `guess-${i}` },
    });
    statuses.push(res.statusCode);
  }
  return statuses;
}

describe('login rate limit (10 per minute per client)', () => {
  it('control: refuses a client after 10 attempts when it sends no X-Forwarded-For of its own', async () => {
    const statuses = await loginStatuses(() => REAL_CLIENT);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('still counts a client that puts a different X-Forwarded-For in front of nginx every time', async () => {
    const statuses = await loginStatuses((i) => `203.0.113.${i + 1}, ${REAL_CLIENT}`);
    // Everything came from one machine: attempts past the 10th within the minute must be refused.
    expect(statuses.filter((s) => s === 429).length, `statuses: ${statuses.join(' ')}`).toBeGreaterThan(0);
  });
});
