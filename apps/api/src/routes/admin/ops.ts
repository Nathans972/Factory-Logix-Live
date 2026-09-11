import type { AuditListResponse, OkResponse, SyncHealth, SyncLogEntry } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit.js';
import { requireRole } from '../../auth/index.js';
import type { AppContext } from '../../context.js';
import { listAuditEntries } from '../../db/repo/audit.js';
import { listSyncLog, requestBackfillNow } from '../../db/repo/sync.js';
import { sendControl } from '../../notify.js';
import { buildSyncHealth } from '../../services/sync-health.js';
import { qInt } from '../../util/query.js';

export async function registerAdminOpsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const admin = { preHandler: requireRole('admin') };

  app.get('/api/admin/sync', admin, async (): Promise<SyncHealth> => buildSyncHealth(ctx.db));

  app.get('/api/admin/sync/log', admin, async (req): Promise<SyncLogEntry[]> => {
    const query = req.query as Record<string, unknown>;
    const limit = qInt(query.limit, { min: 1, max: 500, fallback: 50 }) ?? 50;
    return listSyncLog(ctx.db, limit);
  });

  app.post('/api/admin/backfill/run', admin, async (req): Promise<OkResponse> => {
    const progress = await requestBackfillNow(ctx.db);
    try {
      await sendControl(ctx.db, { cmd: 'backfill_now' });
    } catch (err) {
      ctx.log.warn({ err }, 'could not notify the collector');
    }
    await audit(req, 'backfill.requested', 'sync_state', 'backfill', null, progress);
    return { ok: true };
  });

  app.get('/api/admin/audit', admin, async (req): Promise<AuditListResponse> => {
    const query = req.query as Record<string, unknown>;
    const limit = qInt(query.limit, { min: 1, max: 500, fallback: 100 }) ?? 100;
    const offset = qInt(query.offset, { min: 0, fallback: 0 }) ?? 0;
    return listAuditEntries(ctx.db, limit, offset);
  });
}
