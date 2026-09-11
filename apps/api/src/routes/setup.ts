import { setupAdminSchema, type AuthMe, type SetupStatus } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { setSessionCookie } from '../auth/index.js';
import { hashPassword } from '../auth/password.js';
import type { AppContext } from '../context.js';
import { getSettingValue, settingExists } from '../db/repo/settings.js';
import { countUsers, createFirstAdmin } from '../db/repo/users.js';
import { conflict } from '../errors.js';
import { FL_CONNECTION_KEY } from '../services/connection.js';
import { MAPPING_KEY } from '../services/mapping.js';
import { audit } from '../audit.js';
import { parseWith } from '../util/query.js';

async function countRows(ctx: AppContext, table: string): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}

export async function registerSetupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/setup/status', async (): Promise<SetupStatus> => {
    const [users, timezone, connection, mapping, shifts, breaks, backfill] = await Promise.all([
      countUsers(ctx.db),
      settingExists(ctx.db, 'plant_timezone'),
      getSettingValue<{ base_url?: string }>(ctx.db, FL_CONNECTION_KEY),
      settingExists(ctx.db, MAPPING_KEY),
      countRows(ctx, 'shifts'),
      countRows(ctx, 'breaks'),
      ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM sync_state WHERE source = 'backfill'"),
    ]);
    const adminUserRes = await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE active AND role = 'admin'",
    );
    return {
      needs_setup: users === 0,
      steps: {
        admin_user: (adminUserRes.rows[0]?.n ?? 0) > 0,
        timezone,
        connection: Boolean(connection?.base_url),
        mapping,
        shifts: shifts > 0,
        breaks: breaks > 0,
        backfill: (backfill.rows[0]?.n ?? 0) > 0,
      },
    };
  });

  // Works only while `users` is empty.
  app.post('/api/setup/admin', async (req, reply): Promise<AuthMe> => {
    const body = parseWith(setupAdminSchema, req.body);
    const hash = await hashPassword(body.password);
    const user = await createFirstAdmin(ctx.db, body.username, hash);
    if (!user) throw conflict('setup has already been completed');
    req.auth = user;
    await audit(req, 'setup.admin_created', 'user', user.id, null, { username: user.username, role: user.role });
    await setSessionCookie(reply, user, ctx.env.sessionSecret);
    return { user };
  });
}
