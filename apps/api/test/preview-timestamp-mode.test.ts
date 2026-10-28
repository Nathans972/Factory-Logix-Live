import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { EXAMPLE_MAPPING, type MappingPreviewResult } from '@fld/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { registerAdminSettingsRoutes } from '../src/routes/admin/settings.js';

/**
 * Mapping wizard step 4 ("Test and preview") is where the admin confirms that FactoryLogix's
 * timestamps are read correctly: the page shows "Timestamp skew" and, past a threshold, the warning
 * "Check the timestamp mode on the FactoryLogix page". FactoryLogix here writes plant wall-clock time
 * with no offset and the plant is set to `local_no_offset` with the right zone (Asia/Kolkata, UTC+5:30,
 * no daylight saving, so the numbers do not depend on the date or on the TZ of the machine running the
 * test). The newest row is "now" in the plant, so the skew must be about zero and no warning is due.
 */
const PLANT_TZ = 'Asia/Kolkata';
const PLANT_OFFSET_MS = 5.5 * 3_600_000;

let fake: http.Server;
let server: FastifyInstance;

beforeAll(async () => {
  fake = http.createServer((_req, res) => {
    const plantNow = new Date(Date.now() + PLANT_OFFSET_MS).toISOString().slice(0, 19); // no offset, plant wall clock
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: [{ WorkOrderNumber: 'J00000001-0001', PartNumber: 'P-1', ModifiedDate: plantNow }] }));
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/odata`;

  const settingsRows = [
    { key: 'plant_timezone', value: PLANT_TZ },
    { key: 'fl_timestamp_mode', value: 'local_no_offset' },
  ];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WHERE key = $1')) {
        if (params[0] === 'fl_connection') {
          return { rows: [{ key: 'fl_connection', value: { base_url: baseUrl, username: 'svc', password_enc: null } }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SELECT key, value FROM settings')) return { rows: settingsRows, rowCount: settingsRows.length };
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

describe('mapping preview with plant-local timestamps and fl_timestamp_mode = local_no_offset', () => {
  it('reports a timestamp skew of about zero when the newest row is the current plant time', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/admin/mapping/preview',
      payload: { dataset: 'work_orders', mapping: { work_orders: EXAMPLE_MAPPING.work_orders } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MappingPreviewResult;
    expect(body.ok).toBe(true);
    expect(body.rows).toHaveLength(1);
    const skew = body.checks.timestamp_skew_minutes;
    expect(skew, 'timestamp_skew_minutes').not.toBeNull();
    // Today the naive plant time is read as if it were UTC (or as the API machine's own zone): about -330 min.
    expect(Math.abs(skew as number)).toBeLessThan(30);
    expect(body.checks.warnings.filter((w) => /timestamp mode/i.test(w))).toEqual([]);
  });
});
