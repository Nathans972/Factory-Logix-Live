import { breakWriteSchema, shiftWriteSchema, type BreakDef, type OkResponse, type ShiftDef } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit.js';
import { requireRole } from '../../auth/index.js';
import type { AppContext } from '../../context.js';
import { withTransaction } from '../../db/pool.js';
import {
  addShiftVersionToBreaks,
  closeShiftVersion,
  deleteBreak,
  deleteShift,
  getBreak,
  getShift,
  insertBreak,
  insertShift,
  listBreaks,
  listShifts,
  updateBreak,
  updateShift,
} from '../../db/repo/schedule.js';
import { badRequest, notFound } from '../../errors.js';
import { sendControl } from '../../notify.js';
import { findOverlappingShift, previousDay } from '../../services/shift-validation.js';
import { parseWith, requireIdParam } from '../../util/query.js';

export async function registerAdminScheduleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const viewer = { preHandler: requireRole('viewer') };
  const admin = { preHandler: requireRole('admin') };

  const configChanged = async (): Promise<void> => {
    ctx.sse.broadcast({ type: 'settings_updated', at: Date.now() });
    try {
      await sendControl(ctx.db, { cmd: 'restart' });
    } catch (err) {
      ctx.log.warn({ err }, 'could not notify the collector');
    }
  };

  // ---------------- shifts ----------------

  app.get('/api/admin/shifts', viewer, async (): Promise<ShiftDef[]> => listShifts(ctx.db));

  app.post('/api/admin/shifts', admin, async (req): Promise<ShiftDef> => {
    const body = parseWith(shiftWriteSchema, req.body);
    const existing = await listShifts(ctx.db);
    const clash = findOverlappingShift(body, existing);
    if (clash) throw badRequest(`overlaps shift "${clash.name}" (${clash.start_local}-${clash.end_local})`);
    const created = await insertShift(ctx.db, body, req.auth?.username ?? null);
    await audit(req, 'shift.created', 'shift', created.id, null, created);
    await configChanged();
    return created;
  });

  /**
   * Versioned update: a new effective_from closes the previous version (effective_to = new
   * effective_from - 1 day) and inserts a new row, so past shifts keep the definition in effect then.
   * Breaks scoped to the shift get the new row's id too, or they would stop applying with the old row.
   */
  app.put('/api/admin/shifts/:id', admin, async (req): Promise<ShiftDef> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const body = parseWith(shiftWriteSchema, req.body);
    const before = await getShift(ctx.db, id);
    if (!before) throw notFound('unknown shift');

    const all = await listShifts(ctx.db);
    const versioning = body.effective_from > before.effective_from;
    const others = all
      .filter((s) => s.id !== id)
      .concat(versioning ? [{ ...before, effective_to: previousDay(body.effective_from) }] : []);
    const clash = findOverlappingShift(body, others);
    if (clash) throw badRequest(`overlaps shift "${clash.name}" (${clash.start_local}-${clash.end_local})`);

    let result: ShiftDef | null;
    if (versioning) {
      const { created, carried } = await withTransaction(ctx.pool, async (tx) => {
        await closeShiftVersion(tx, id, previousDay(body.effective_from));
        const inserted = await insertShift(tx, body, req.auth?.username ?? null);
        return { created: inserted, carried: await addShiftVersionToBreaks(tx, id, inserted.id) };
      });
      result = created;
      await audit(req, 'shift.versioned', 'shift', created.id, before, created);
      for (const b of carried) {
        const previous = { ...b, shift_ids: (b.shift_ids ?? []).filter((s) => s !== created.id) };
        await audit(req, 'break.updated', 'break', b.id, previous, b);
      }
    } else {
      result = await updateShift(ctx.db, id, body);
      if (!result) throw notFound('unknown shift');
      await audit(req, 'shift.updated', 'shift', id, before, result);
    }
    await configChanged();
    return result;
  });

  app.delete('/api/admin/shifts/:id', admin, async (req): Promise<OkResponse> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const before = await getShift(ctx.db, id);
    if (!before) throw notFound('unknown shift');
    await deleteShift(ctx.db, id);
    await audit(req, 'shift.deleted', 'shift', id, before, null);
    await configChanged();
    return { ok: true };
  });

  // ---------------- breaks ----------------

  app.get('/api/admin/breaks', viewer, async (): Promise<BreakDef[]> => listBreaks(ctx.db));

  app.post('/api/admin/breaks', admin, async (req): Promise<BreakDef> => {
    const body = parseWith(breakWriteSchema, req.body);
    const created = await insertBreak(ctx.db, body, req.auth?.username ?? null);
    await audit(req, 'break.created', 'break', created.id, null, created);
    await configChanged();
    return created;
  });

  app.put('/api/admin/breaks/:id', admin, async (req): Promise<BreakDef> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const body = parseWith(breakWriteSchema, req.body);
    const before = await getBreak(ctx.db, id);
    if (!before) throw notFound('unknown break');
    const updated = await updateBreak(ctx.db, id, body);
    if (!updated) throw notFound('unknown break');
    await audit(req, 'break.updated', 'break', id, before, updated);
    await configChanged();
    return updated;
  });

  app.delete('/api/admin/breaks/:id', admin, async (req): Promise<OkResponse> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const before = await getBreak(ctx.db, id);
    if (!before) throw notFound('unknown break');
    await deleteBreak(ctx.db, id);
    await audit(req, 'break.deleted', 'break', id, before, null);
    await configChanged();
    return { ok: true };
  });
}
