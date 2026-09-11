import { DEFAULT_SETTINGS, type AppHealth, type SyncHealth } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { pingDb } from '../db/pool.js';
import { getSettings } from '../db/repo/settings.js';
import { countUsers } from '../db/repo/users.js';
import { buildSyncHealth } from '../services/sync-health.js';

export async function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    const now = Date.now();
    const db = await pingDb(ctx.db);
    let plantTimezone = DEFAULT_SETTINGS.plant_timezone;
    let plantName = DEFAULT_SETTINGS.plant_name;
    let needsSetup = false;
    if (db) {
      try {
        const [settings, users] = await Promise.all([getSettings(ctx.db), countUsers(ctx.db)]);
        plantTimezone = settings.plant_timezone;
        plantName = settings.plant_name;
        needsSetup = users === 0;
      } catch (err) {
        ctx.log.warn({ err }, 'health: could not read settings');
      }
    }
    const health: AppHealth = {
      ok: db,
      db,
      version: ctx.version,
      server_time: now,
      plant_timezone: plantTimezone,
      plant_name: plantName,
      needs_setup: needsSetup,
      demo: false,
    };
    return reply.code(db ? 200 : 503).send(health);
  });

  app.get('/api/health/sync', async (): Promise<SyncHealth> => buildSyncHealth(ctx.db));
}
