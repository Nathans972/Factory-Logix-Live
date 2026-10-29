/**
 * Saving a mapping that changes the natural key of unit_steps or defects keeps the old key in
 * `mapping_key_history`. The collector stored rows under it, and reads its fields again to replace
 * those copies when it reads the rows again; without it, every row read again became a second row
 * (proof in apps/collector/test/rt1-natural-key-change.test.ts).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_MAPPING, MAPPING_KEY_HISTORY, type MappingConfig, type Role } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { registerAdminSettingsRoutes } from '../src/routes/admin/settings.js';

/** The `settings` table, plus every write to it in order. */
function fakeDb() {
  const settings = new Map<string, unknown>();
  const writes: string[] = [];
  const ok = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.includes('pg_notify') || q.startsWith('INSERT INTO audit_log')) return ok();
      if (q.startsWith('SELECT key, value FROM settings WHERE key = $1')) {
        const key = params[0] as string;
        return ok(settings.has(key) ? [{ key, value: settings.get(key) }] : []);
      }
      if (q.startsWith('INSERT INTO settings')) {
        settings.set(params[0] as string, JSON.parse(params[1] as string));
        writes.push(params[0] as string);
        return ok();
      }
      throw new Error(`fake db: unexpected SQL ${q}`);
    },
  };
  return { db, settings, writes };
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function appFor(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { id: 1, username: 'admin', role: 'admin' as Role, active: true, created_at: 0, last_login_at: null };
  });
  const ctx = { db, pool: db, log: { warn: () => undefined, error: () => undefined }, sse: { broadcast: () => undefined } } as unknown as AppContext;
  app.decorate('ctx', ctx);
  await registerAdminSettingsRoutes(app, ctx);
  server = app;
  return app;
}

function withKeys(stepKey: string[], defectKey: string[] | null = ['DefectId']): MappingConfig {
  const mapping = structuredClone(EXAMPLE_MAPPING);
  mapping.unit_steps.key = stepKey;
  mapping.defects = defectKey ? { ...(mapping.defects as NonNullable<MappingConfig['defects']>), key: defectKey } : null;
  return mapping;
}

async function save(app: FastifyInstance, mapping: MappingConfig): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: '/api/admin/mapping', payload: mapping });
  expect(res.statusCode).toBe(200);
}

describe('PUT /api/admin/mapping and the natural keys a dataset had before', () => {
  it('keeps the unit_steps key it replaces, written before the mapping', async () => {
    const store = fakeDb();
    const app = await appFor(store.db);
    await save(app, withKeys(['UnitHistoryId']));
    expect(store.settings.has(MAPPING_KEY_HISTORY)).toBe(false);

    await save(app, withKeys(['UnitHistoryId', 'OperationName']));

    expect(store.settings.get(MAPPING_KEY_HISTORY)).toEqual({ unit_steps: [['UnitHistoryId']] });
    expect(store.writes.slice(-2)).toEqual([MAPPING_KEY_HISTORY, 'mapping']);
    expect((store.settings.get('mapping') as MappingConfig).unit_steps.key).toEqual(['UnitHistoryId', 'OperationName']);
  });

  it('leaves the history alone when the key stays, and never stores previous_keys sent with the mapping', async () => {
    const store = fakeDb();
    const app = await appFor(store.db);
    await save(app, withKeys(['UnitHistoryId']));
    const sent = withKeys(['UnitHistoryId']);
    sent.unit_steps.previous_keys = [['Forged']];
    await save(app, sent);

    expect(store.writes).toEqual(['mapping', 'mapping']);
    expect(store.settings.get('mapping')).not.toHaveProperty('unit_steps.previous_keys');
  });

  it('keeps every key a dataset had, also while it is not used, and drops the one in use again', async () => {
    const store = fakeDb();
    const app = await appFor(store.db);
    await save(app, withKeys(['A']));
    await save(app, withKeys(['A', 'B']));
    await save(app, withKeys(['C'], null)); // defects no longer used
    expect(store.settings.get(MAPPING_KEY_HISTORY)).toEqual({ unit_steps: [['A'], ['A', 'B']], defects: [['DefectId']] });

    await save(app, withKeys(['A'], ['DefectId']));
    expect(store.settings.get(MAPPING_KEY_HISTORY)).toEqual({ unit_steps: [['A', 'B'], ['C']] });
  });
});
