import { tvRegisterSchema, type TvState } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getDisplayRowByToken, insertDisplay, pruneUnclaimedDisplays } from '../db/repo/displays.js';
import { notFound, tooManyRequests } from '../errors.js';
import { adminUrlFor, buildTvState } from '../services/tv.js';
import { parseWith } from '../util/query.js';

/** New displays one client address may register a minute. A TV registers once, on its first load of /tv. */
const NEW_DISPLAYS_PER_MINUTE = 10;
/** More TVs than a plant switches on before claiming them, and far fewer than the 9000 pairing codes. */
const MAX_UNCLAIMED_DISPLAYS = 1000;

export async function registerTvRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Keyed on req.ip like the login limit. Only registrations that create a display count: a known
  // TV registers again on every page load and is never refused.
  const newDisplayLimit = app.createRateLimit({ max: NEW_DISPLAYS_PER_MINUTE, timeWindow: '1 minute' });

  app.post('/api/tv/register', async (req, reply): Promise<TvState> => {
    const body = parseWith(tvRegisterSchema, req.body);
    const existing = await getDisplayRowByToken(ctx.db, body.device_token);
    if (existing) return buildTvState(ctx.db, existing, adminUrlFor(req), { touch: true, log: req.log });

    const limit = await newDisplayLimit(req);
    if (!limit.isAllowed && limit.isExceeded) {
      req.log.warn({ ip: req.ip }, 'too many new displays from one address');
      reply.header('retry-after', limit.ttlInSeconds);
      throw tooManyRequests(`too many new displays from this address, retry in ${limit.ttlInSeconds}s`);
    }
    // Keep the unclaimed displays from taking up the code space, however long registrations go on.
    const pruned = await pruneUnclaimedDisplays(ctx.db, MAX_UNCLAIMED_DISPLAYS - 1);
    const row = await insertDisplay(ctx.db, body.device_token);
    ctx.log.info({ display_id: row.id, pairing_code: row.pairing_code, pruned }, 'registered new display');
    ctx.sse.broadcast({ type: 'display_updated', at: Date.now(), display_id: row.id });
    return buildTvState(ctx.db, row, adminUrlFor(req), { log: req.log });
  });

  app.get('/api/tv/:token/state', async (req): Promise<TvState> => {
    const { token } = req.params as { token: string };
    if (!/^[0-9a-fA-F-]{36}$/.test(token)) throw notFound('unknown device token');
    const row = await getDisplayRowByToken(ctx.db, token);
    if (!row) throw notFound('unknown device token');
    return buildTvState(ctx.db, row, adminUrlFor(req), { touch: true, log: req.log });
  });
}
