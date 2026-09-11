import {
  createAdjustmentSchema,
  createOverrideSchema,
  createPinSchema,
  type FloorView,
  type JobDetail,
  type JobListItem,
  type JobListResponse,
  type OkResponse,
  type OperatorDetail,
  type OperatorListItem,
  type Pin,
  type PinListResponse,
  type ProductListItem,
  type ProductView,
  type ShiftInstanceListItem,
  type ShiftPickerResponse,
  type ShiftView,
  type StandardAdjustment,
  type StandardOverride,
  type TvDashboard,
} from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireRole } from '../auth/index.js';
import type { AppContext } from '../context.js';
import { getOrCreateOperationId } from '../db/repo/operations.js';
import { listOperators } from '../db/repo/operators.js';
import { deletePin, getPin, insertPin, listPins } from '../db/repo/pins.js';
import { listProducts } from '../db/repo/products.js';
import { getDerivedQtyComplete, getRoutesForProducts } from '../db/repo/routes.js';
import {
  deactivateAdjustment,
  deactivateOverride,
  getAdjustment,
  getOverride,
  insertAdjustment,
  insertOverride,
} from '../db/repo/standards.js';
import { isJobActive, listJobsWithActivity } from '../db/repo/work-orders.js';
import { badRequest, notFound } from '../errors.js';
import { sendControl } from '../notify.js';
import { buildDashboard } from '../services/dashboard.js';
import { buildFloor } from '../services/floor.js';
import { buildJobDetailForJob } from '../services/job-detail.js';
import { buildOperatorDetailForQuery } from '../services/operator-detail.js';
import { buildProductViewFor } from '../services/product.js';
import { buildShiftPicker, buildShiftViewForQuery, listShiftInstancesInRange } from '../services/shift-view.js';
import { parseWith, qBool, qInt, qNum, qStr, requireIdParam } from '../util/query.js';

const HOUR_MS = 3_600_000;

export async function registerPortalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const viewer = { preHandler: requireRole('viewer') };
  const manager = { preHandler: requireRole('manager') };

  // ---------------- shifts ----------------

  app.get('/api/portal/shifts', viewer, async (): Promise<ShiftPickerResponse> => buildShiftPicker(ctx.db));

  app.get('/api/portal/shifts/instances', viewer, async (req): Promise<ShiftInstanceListItem[]> => {
    const query = req.query as Record<string, unknown>;
    const now = Date.now();
    const from = qNum(query.from) ?? now - 7 * 24 * HOUR_MS;
    const to = qNum(query.to) ?? now + 24 * HOUR_MS;
    if (to <= from) throw badRequest('to must be greater than from');
    return listShiftInstancesInRange(ctx.db, from, to, now);
  });

  app.get('/api/portal/shift-view', viewer, async (req): Promise<ShiftView> => {
    const query = req.query as Record<string, unknown>;
    return buildShiftViewForQuery(ctx.db, {
      date: qStr(query.date),
      shift_id: qInt(query.shift_id),
      job: qStr(query.job),
      product: qStr(query.product),
      operation: qStr(query.operation),
      operator: qStr(query.operator),
    });
  });

  // ---------------- floor ----------------

  app.get('/api/portal/floor', viewer, async (req): Promise<FloorView> => {
    const query = req.query as Record<string, unknown>;
    return buildFloor(ctx.db, qBool(query.show_visitors, false));
  });

  // ---------------- operators ----------------

  app.get('/api/portal/operators', viewer, async (req): Promise<OperatorListItem[]> => {
    const query = req.query as Record<string, unknown>;
    return listOperators(ctx.db, qStr(query.q));
  });

  app.get('/api/portal/operators/:id', viewer, async (req): Promise<OperatorDetail> => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, unknown>;
    return buildOperatorDetailForQuery(ctx.db, id, {
      from: qNum(query.from),
      to: qNum(query.to),
      date: qStr(query.date),
      shift_id: qInt(query.shift_id),
    });
  });

  // ---------------- jobs ----------------

  app.get('/api/portal/jobs', viewer, async (req): Promise<JobListResponse> => {
    const query = req.query as Record<string, unknown>;
    const now = Date.now();
    const rows = await listJobsWithActivity(ctx.db, { q: qStr(query.q), active: qBool(query.active, false) });

    const needDerived = rows.filter((r) => r.work_order.qty_complete === null).map((r) => r.work_order);
    let derived: Record<string, number> = {};
    if (needDerived.length > 0) {
      const routes = await getRoutesForProducts(ctx.db, needDerived.map((w) => w.product_number));
      derived = await getDerivedQtyComplete(
        ctx.db,
        needDerived.map((w) => ({ job_number: w.job_number, product_number: w.product_number })),
        routes,
      );
    }

    const jobs: JobListItem[] = rows.map(({ work_order, last_activity_at }) => {
      const effective = work_order.qty_complete ?? derived[work_order.job_number] ?? 0;
      return {
        ...work_order,
        qty_complete_effective: effective,
        progress: work_order.qty_released > 0 ? effective / work_order.qty_released : 0,
        last_activity_at,
        active: isJobActive(work_order.status, last_activity_at, now),
      };
    });
    return { jobs };
  });

  app.get('/api/portal/jobs/:job', viewer, async (req): Promise<JobDetail> => {
    const { job } = req.params as { job: string };
    return buildJobDetailForJob(ctx.db, job);
  });

  app.get('/api/portal/dashboard/:job', viewer, async (req): Promise<TvDashboard> => {
    const { job } = req.params as { job: string };
    const query = req.query as Record<string, unknown>;
    return buildDashboard(ctx.db, job, {
      grouped: qBool(query.grouped, false),
      show_std_day: qBool(query.show_std_day, true),
      shift_length_hours: qNum(query.shift_length_hours) ?? 12,
    });
  });

  // ---------------- products / standards ----------------

  app.get('/api/portal/products', viewer, async (req): Promise<ProductListItem[]> => {
    const query = req.query as Record<string, unknown>;
    return listProducts(ctx.db, qStr(query.q));
  });

  app.get('/api/portal/products/:z', viewer, async (req): Promise<ProductView> => {
    const { z } = req.params as { z: string };
    return buildProductViewFor(ctx.db, z);
  });

  app.post('/api/portal/products/:z/adjustments', manager, async (req): Promise<StandardAdjustment> => {
    const { z } = req.params as { z: string };
    const body = parseWith(createAdjustmentSchema, req.body);
    if (body.scope !== 'product' && body.scope !== 'product_operation') {
      throw badRequest('scope must be product or product_operation here; use /api/admin/standards/adjustments for global and operation scopes');
    }
    if (body.product_number && body.product_number !== z) throw badRequest('product_number does not match the URL');
    const operationId = body.operation ? await getOrCreateOperationId(ctx.db, body.operation) : null;
    const created = await insertAdjustment(ctx.db, {
      scope: body.scope,
      product_number: z,
      operation_id: operationId,
      percent: body.percent,
      created_by: req.auth?.username ?? null,
      note: body.note,
    });
    await audit(req, 'standards.adjustment_created', 'standard_adjustment', created.id, null, created);
    return created;
  });

  app.delete('/api/portal/adjustments/:id', manager, async (req): Promise<OkResponse> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const before = await getAdjustment(ctx.db, id);
    if (!before) throw notFound('unknown adjustment');
    await deactivateAdjustment(ctx.db, id);
    await audit(req, 'standards.adjustment_deleted', 'standard_adjustment', id, before, null);
    return { ok: true };
  });

  app.post('/api/portal/products/:z/overrides', manager, async (req): Promise<StandardOverride> => {
    const { z } = req.params as { z: string };
    const body = parseWith(createOverrideSchema, req.body);
    if (body.product_number !== z) throw badRequest('product_number does not match the URL');
    const operationId = body.operation ? await getOrCreateOperationId(ctx.db, body.operation) : null;
    const created = await insertOverride(ctx.db, {
      scope: body.scope,
      product_number: z,
      operation_id: operationId,
      std_hr: body.std_hr,
      created_by: req.auth?.username ?? null,
      note: body.note,
    });
    await audit(req, 'standards.override_created', 'standard_override', created.id, null, created);
    return created;
  });

  app.delete('/api/portal/overrides/:id', manager, async (req): Promise<OkResponse> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const before = await getOverride(ctx.db, id);
    if (!before) throw notFound('unknown override');
    await deactivateOverride(ctx.db, id);
    await audit(req, 'standards.override_deleted', 'standard_override', id, before, null);
    return { ok: true };
  });

  app.post('/api/portal/products/:z/recompute', manager, async (req): Promise<OkResponse> => {
    const { z } = req.params as { z: string };
    await sendControl(ctx.db, { cmd: 'recompute_standards', product_number: z });
    await audit(req, 'standards.recompute_requested', 'product', z, null, { product_number: z });
    return { ok: true };
  });

  // ---------------- pins ----------------

  app.get('/api/portal/pins', viewer, async (req): Promise<PinListResponse> => {
    const query = req.query as Record<string, unknown>;
    const pins = await listPins(ctx.db, {
      operator_id: qStr(query.operator_id),
      job_number: qStr(query.job_number),
    });
    return { pins };
  });

  app.post('/api/portal/pins', manager, async (req): Promise<Pin> => {
    const body = parseWith(createPinSchema, req.body);
    const operationId = body.operation ? await getOrCreateOperationId(ctx.db, body.operation) : null;
    const created = await insertPin(ctx.db, {
      operator_id: body.operator_id,
      job_number: body.job_number,
      operation_id: operationId,
      mode: body.mode,
      created_by: req.auth?.username ?? null,
      expires_at: body.expires_at ?? null,
    });
    await audit(req, 'pin.created', 'operator_pin', created.id, null, created);
    return created;
  });

  app.delete('/api/portal/pins/:id', manager, async (req): Promise<OkResponse> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const before = await getPin(ctx.db, id);
    if (!before) throw notFound('unknown pin');
    await deletePin(ctx.db, id);
    await audit(req, 'pin.deleted', 'operator_pin', id, before, null);
    return { ok: true };
  });
}
