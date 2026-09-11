import { tvRegisterSchema, type TvState } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getDisplayRowByToken, insertDisplay } from '../db/repo/displays.js';
import { notFound } from '../errors.js';
import { adminUrlFor, buildTvState } from '../services/tv.js';
import { parseWith } from '../util/query.js';

export async function registerTvRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/tv/register', async (req): Promise<TvState> => {
    const body = parseWith(tvRegisterSchema, req.body);
    const existing = await getDisplayRowByToken(ctx.db, body.device_token);
    const row = existing ?? (await insertDisplay(ctx.db, body.device_token));
    if (!existing) {
      ctx.log.info({ display_id: row.id, pairing_code: row.pairing_code }, 'registered new display');
      ctx.sse.broadcast({ type: 'display_updated', at: Date.now(), display_id: row.id, device_token: row.device_token });
    }
    return buildTvState(ctx.db, row, adminUrlFor(req), { touch: Boolean(existing), log: req.log });
  });

  app.get('/api/tv/:token/state', async (req): Promise<TvState> => {
    const { token } = req.params as { token: string };
    if (!/^[0-9a-fA-F-]{36}$/.test(token)) throw notFound('unknown device token');
    const row = await getDisplayRowByToken(ctx.db, token);
    if (!row) throw notFound('unknown device token');
    return buildTvState(ctx.db, row, adminUrlFor(req), { touch: true, log: req.log });
  });
}
