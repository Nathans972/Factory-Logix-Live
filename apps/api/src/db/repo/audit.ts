import type { AuditEntry } from '@fld/shared';
import type { Db } from '../pool.js';
import { toMsOr } from '../util.js';

export async function insertAuditEntry(
  db: Db,
  entry: {
    user_id: number | null;
    action: string;
    entity: string;
    entity_id: string | null;
    before: unknown;
    after: unknown;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, "before", "after")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      entry.user_id,
      entry.action,
      entry.entity,
      entry.entity_id,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}

export async function listAuditEntries(
  db: Db,
  limit: number,
  offset: number,
): Promise<{ entries: AuditEntry[]; total: number }> {
  const countRes = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log');
  const { rows } = await db.query<{
    id: number;
    at: Date;
    user_id: number | null;
    username: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    before: unknown;
    after: unknown;
  }>(
    `SELECT a.id, a.at, a.user_id, u.username, a.action, a.entity, a.entity_id, a."before", a."after"
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.at DESC, a.id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return {
    total: countRes.rows[0]?.n ?? 0,
    entries: rows.map((r) => ({
      id: Number(r.id),
      at: toMsOr(r.at, 0),
      user_id: r.user_id === null ? null : Number(r.user_id),
      username: r.username,
      action: r.action,
      entity: r.entity,
      entity_id: r.entity_id,
      before: r.before ?? null,
      after: r.after ?? null,
    })),
  };
}
