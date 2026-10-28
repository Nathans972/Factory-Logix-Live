import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';

/**
 * `POST /api/tv/register` needs no login and has no rate limit. Every unknown `device_token` inserts a
 * `displays` row (they never expire) with one of only 9000 four-digit pairing codes, and broadcasts a
 * `display_updated` event that makes every connected TV and admin page refetch. A loop on any LAN machine
 * therefore fills the table, uses up the pairing codes (insertDisplay then throws, so no real TV can be
 * paired) and keeps every TV refetching its dashboard.
 */
const attempts = 1000;

interface Counters {
  inserted: number;
  broadcasts: number;
}

function ctx(counters: Counters): AppContext {
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ');
    if (/INSERT INTO displays/i.test(sql)) {
      counters.inserted += 1;
      return {
        rows: [
          {
            id: counters.inserted,
            pairing_code: String(1000 + (counters.inserted % 9000)),
            device_token: params[1],
            name: null,
            claimed_at: null,
            job_number: null,
            group_operators: false,
            show_std_day: true,
            show_gauge: true,
            shift_length_hours: 12,
            last_seen_at: new Date(),
            created_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const db = { query };
  return {
    env: { sessionSecret: 'k7Qm2vXz9LrT4pWc8NfYb3HsJd6AaEu5GxV1oRiBt0Zy' },
    db,
    pool: db,
    log: pino({ level: 'silent' }),
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => (counters.broadcasts += 1) },
    version: 'test',
  } as unknown as AppContext;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('POST /api/tv/register from a single client', () => {
  it('is throttled before it has created and announced a thousand displays', async () => {
    const counters: Counters = { inserted: 0, broadcasts: 0 };
    app = await buildServer(ctx(counters));
    const statuses: number[] = [];
    for (let i = 0; i < attempts; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tv/register',
        remoteAddress: '172.18.0.5',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
        payload: JSON.stringify({ device_token: randomUUID() }),
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(counters.inserted).toBeLessThan(attempts);
    expect(counters.broadcasts).toBeLessThan(attempts);
  });

  it('answers a normal first registration (baseline)', async () => {
    const counters: Counters = { inserted: 0, broadcasts: 0 };
    app = await buildServer(ctx(counters));
    const res = await app.inject({
      method: 'POST',
      url: '/api/tv/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ device_token: randomUUID() }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unclaimed' });
  });
});
