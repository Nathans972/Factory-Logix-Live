/** Audit trail for every mutating admin/manager endpoint (spec 14: "audit log for all configuration changes"). */
import type { FastifyRequest } from 'fastify';
import { insertAuditEntry } from './db/repo/audit.js';

export async function audit(
  req: FastifyRequest,
  action: string,
  entity: string,
  entity_id: string | number | null,
  before: unknown = null,
  after: unknown = null,
): Promise<void> {
  try {
    await insertAuditEntry(req.server.ctx.db, {
      user_id: req.auth?.id ?? null,
      action,
      entity,
      entity_id: entity_id === null || entity_id === undefined ? null : String(entity_id),
      before: before ?? null,
      after: after ?? null,
    });
  } catch (err) {
    req.log.error({ err, action, entity }, 'failed to write audit log entry');
  }
}
