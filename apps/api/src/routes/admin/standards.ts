import {
  createAdjustmentSchema,
  type OkResponse,
  type RecomputeStandardsRequest,
  type StandardAdjustment,
  type StandardsAdminResponse,
} from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit.js';
import { requireRole } from '../../auth/index.js';
import type { AppContext } from '../../context.js';
import { getOrCreateOperationId, listOperationNames } from '../../db/repo/operations.js';
import {
  deactivateAdjustment,
  getAdjustment,
  insertAdjustment,
  listAdjustments,
  listOverrides,
  retireReplacedAdjustments,
} from '../../db/repo/standards.js';
import { getCollectorState } from '../../db/repo/sync.js';
import { badRequest, notFound } from '../../errors.js';
import { sendControl } from '../../notify.js';
import { parseWith, requireIdParam } from '../../util/query.js';

export async function registerAdminStandardsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const manager = { preHandler: requireRole('manager') };

  app.get('/api/admin/standards', manager, async (): Promise<StandardsAdminResponse> => {
    const [adjustments, overrides, operations, state] = await Promise.all([
      listAdjustments(ctx.db, { activeOnly: true }),
      listOverrides(ctx.db, { activeOnly: true }),
      listOperationNames(ctx.db),
      getCollectorState(ctx.db),
    ]);
    return { adjustments, overrides, operations, last_recompute_at: state.last_standards_recompute_at };
  });

  app.post('/api/admin/standards/adjustments', manager, async (req): Promise<StandardAdjustment> => {
    const body = parseWith(createAdjustmentSchema, req.body);
    if (body.scope !== 'global' && body.scope !== 'operation') {
      throw badRequest('scope must be global or operation here; use /api/portal/products/:z/adjustments for product scopes');
    }
    const operationId = body.operation ? await getOrCreateOperationId(ctx.db, body.operation) : null;
    const created = await insertAdjustment(ctx.db, {
      scope: body.scope,
      product_number: null,
      operation_id: operationId,
      percent: body.percent,
      created_by: req.auth?.username ?? null,
      note: body.note,
    });
    await audit(req, 'standards.adjustment_created', 'standard_adjustment', created.id, null, created);
    for (const old of await retireReplacedAdjustments(ctx.db, created)) {
      await audit(req, 'standards.adjustment_replaced', 'standard_adjustment', old.id, old, created);
    }
    return created;
  });

  app.delete('/api/admin/standards/adjustments/:id', manager, async (req): Promise<OkResponse> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const before = await getAdjustment(ctx.db, id);
    if (!before) throw notFound('unknown adjustment');
    await deactivateAdjustment(ctx.db, id);
    await audit(req, 'standards.adjustment_deleted', 'standard_adjustment', id, before, null);
    return { ok: true };
  });

  app.post('/api/admin/standards/recompute', manager, async (req): Promise<OkResponse> => {
    const body = (req.body ?? {}) as RecomputeStandardsRequest;
    const productNumber = typeof body.product_number === 'string' && body.product_number.length > 0 ? body.product_number : undefined;
    await sendControl(ctx.db, { cmd: 'recompute_standards', product_number: productNumber });
    await audit(req, 'standards.recompute_requested', 'standards', productNumber ?? null, null, {
      product_number: productNumber ?? null,
    });
    return { ok: true };
  });
}
