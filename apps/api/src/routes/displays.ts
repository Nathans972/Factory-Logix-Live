/**
 * Manager-level TV routes: every manager can see the TVs and change which job each one shows.
 * Pairing, renaming, display options and deleting stay admin-only (routes/admin/displays.ts).
 */
import { setDisplayJobSchema, type Display } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireRole } from '../auth/index.js';
import type { AppContext } from '../context.js';
import { getDisplayRowById, listDisplayRows, mapDisplay, updateDisplayRow } from '../db/repo/displays.js';
import { getSettings } from '../db/repo/settings.js';
import { notFound } from '../errors.js';
import { requireIdParam } from '../util/query.js';

export async function registerDisplayRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const manager = { preHandler: requireRole('manager') };

  app.get('/api/displays', manager, async (): Promise<Display[]> => {
    const settings = await getSettings(ctx.db);
    const rows = await listDisplayRows(ctx.db);
    const now = Date.now();
    return rows.map((row) => mapDisplay(row, settings.poll_interval_seconds, now));
  });

  app.put('/api/displays/:id/job', manager, async (req): Promise<Display> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const body = setDisplayJobSchema.parse(req.body);
    const settings = await getSettings(ctx.db);
    const row = await getDisplayRowById(ctx.db, id);
    if (!row) throw notFound('unknown display');
    const before = mapDisplay(row, settings.poll_interval_seconds);
    const updated = await updateDisplayRow(ctx.db, id, { job_number: body.job_number });
    if (!updated) throw notFound('unknown display');
    const display = mapDisplay(updated, settings.poll_interval_seconds);
    await audit(req, 'display.job_changed', 'display', id, before, display);
    ctx.sse.broadcast({ type: 'display_updated', at: Date.now(), display_id: id });
    return display;
  });
}
