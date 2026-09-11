import { claimDisplaySchema, repairDisplaySchema, updateDisplaySchema, type Display, type OkResponse } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit.js';
import { requireRole } from '../../auth/index.js';
import type { AppContext } from '../../context.js';
import { withTransaction } from '../../db/pool.js';
import {
  deleteDisplay,
  getDisplayRowByCode,
  getDisplayRowById,
  listDisplayRows,
  mapDisplay,
  repairDisplayToken,
  updateDisplayRow,
} from '../../db/repo/displays.js';
import { getSettings } from '../../db/repo/settings.js';
import { badRequest, notFound } from '../../errors.js';
import { requireIdParam } from '../../util/query.js';

export async function registerAdminDisplayRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const admin = { preHandler: requireRole('admin') };

  const emit = (id: number, deviceToken?: string): void => {
    ctx.sse.broadcast({ type: 'display_updated', at: Date.now(), display_id: id, device_token: deviceToken });
  };

  app.get('/api/admin/displays', admin, async (): Promise<Display[]> => {
    const settings = await getSettings(ctx.db);
    const rows = await listDisplayRows(ctx.db);
    const now = Date.now();
    return rows.map((row) => mapDisplay(row, settings.poll_interval_seconds, now));
  });

  app.post('/api/admin/displays/claim', admin, async (req): Promise<Display> => {
    const body = claimDisplaySchema.parse(req.body);
    const settings = await getSettings(ctx.db);
    const row = await getDisplayRowByCode(ctx.db, body.pairing_code);
    if (!row) throw notFound(`no display is showing pairing code ${body.pairing_code}`);
    const before = mapDisplay(row, settings.poll_interval_seconds);
    const updated = await updateDisplayRow(ctx.db, row.id, {
      name: body.name,
      job_number: body.job_number ?? null,
      group_operators: body.group_operators,
      show_std_day: body.show_std_day,
      show_gauge: body.show_gauge,
      shift_length_hours: body.shift_length_hours,
      claim: true,
    });
    if (!updated) throw notFound('display disappeared');
    const display = mapDisplay(updated, settings.poll_interval_seconds);
    await audit(req, 'display.claimed', 'display', display.id, before, display);
    emit(display.id, updated.device_token);
    return display;
  });

  app.patch('/api/admin/displays/:id', admin, async (req): Promise<Display> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const body = updateDisplaySchema.parse(req.body);
    const settings = await getSettings(ctx.db);
    const row = await getDisplayRowById(ctx.db, id);
    if (!row) throw notFound('unknown display');
    const before = mapDisplay(row, settings.poll_interval_seconds);
    const updated = await updateDisplayRow(ctx.db, id, body);
    if (!updated) throw notFound('unknown display');
    const display = mapDisplay(updated, settings.poll_interval_seconds);
    await audit(req, 'display.updated', 'display', id, before, display);
    emit(id, updated.device_token);
    return display;
  });

  // Re-pair: the TV lost its token and shows a new code; move that token onto the existing record.
  app.post('/api/admin/displays/:id/repair', admin, async (req): Promise<Display> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const body = repairDisplaySchema.parse(req.body);
    const settings = await getSettings(ctx.db);

    const target = await getDisplayRowById(ctx.db, id);
    if (!target) throw notFound('unknown display');
    const temp = await getDisplayRowByCode(ctx.db, body.pairing_code);
    if (!temp) throw notFound(`no display is showing pairing code ${body.pairing_code}`);
    if (temp.id === id) throw badRequest('that pairing code already belongs to this display');

    const before = mapDisplay(target, settings.poll_interval_seconds);
    const updatedRow = await withTransaction(ctx.pool, async (tx) => repairDisplayToken(tx, id, temp.id));
    if (!updatedRow) throw notFound('unknown display');
    const display = mapDisplay(updatedRow, settings.poll_interval_seconds);
    await audit(req, 'display.repaired', 'display', id, before, {
      ...display,
      moved_from_display_id: temp.id,
      pairing_code_used: body.pairing_code,
    });
    emit(id, updatedRow.device_token);
    emit(temp.id, temp.device_token);
    return display;
  });

  app.delete('/api/admin/displays/:id', admin, async (req): Promise<OkResponse> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const settings = await getSettings(ctx.db);
    const row = await getDisplayRowById(ctx.db, id);
    if (!row) throw notFound('unknown display');
    await deleteDisplay(ctx.db, id);
    await audit(req, 'display.deleted', 'display', id, mapDisplay(row, settings.poll_interval_seconds), null);
    emit(id, row.device_token);
    return { ok: true };
  });
}
