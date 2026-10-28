import type { BackfillProgress, SourceSyncState, SyncLogEntry, SyncStatus } from '@fld/shared';
import type { Db } from '../pool.js';
import { toMs, toMsOr, toNum, toNumOr } from '../util.js';

export interface CollectorState {
  heartbeat_at: number | null;
  breaker_open_until: number | null;
  status: SyncStatus;
  last_error: string | null;
  last_success_at: number | null;
  consecutive_failures: number;
  last_standards_recompute_at: number | null;
}

export const BACKFILL_SOURCE = 'backfill';
/** The collector's standards recomputes of every product (nightly, on demand, after a backfill): not a poll. */
export const STANDARDS_SOURCE = 'standards_recompute';

export async function getCollectorState(db: Db): Promise<CollectorState> {
  const { rows } = await db.query<{
    heartbeat_at: Date | null;
    breaker_open_until: Date | null;
    status: SyncStatus;
    last_error: string | null;
    last_success_at: Date | null;
    consecutive_failures: number;
    last_standards_recompute_at: Date | null;
  }>(
    `SELECT heartbeat_at, breaker_open_until, status, last_error, last_success_at, consecutive_failures,
            last_standards_recompute_at
     FROM collector_state WHERE id = 1`,
  );
  const row = rows[0];
  if (!row) {
    return {
      heartbeat_at: null,
      breaker_open_until: null,
      status: 'never',
      last_error: null,
      last_success_at: null,
      consecutive_failures: 0,
      last_standards_recompute_at: null,
    };
  }
  return {
    heartbeat_at: toMs(row.heartbeat_at),
    breaker_open_until: toMs(row.breaker_open_until),
    status: row.status ?? 'never',
    last_error: row.last_error,
    last_success_at: toMs(row.last_success_at),
    consecutive_failures: toNumOr(row.consecutive_failures, 0),
    last_standards_recompute_at: toMs(row.last_standards_recompute_at),
  };
}

type SyncStateRow = {
  source: string;
  watermark: string | null;
  last_success_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
  rows_last_poll: number | null;
  duration_ms_last_poll: number | null;
  backfill_progress: unknown;
};

export async function listSyncStates(db: Db): Promise<{ sources: SourceSyncState[]; backfill: BackfillProgress | null }> {
  const { rows } = await db.query<SyncStateRow>(
    `SELECT source, watermark, last_success_at, last_error, consecutive_failures, rows_last_poll,
            duration_ms_last_poll, backfill_progress
     FROM sync_state ORDER BY source`,
  );
  const sources: SourceSyncState[] = [];
  let backfill: BackfillProgress | null = null;
  for (const row of rows) {
    if (row.source === BACKFILL_SOURCE) {
      backfill = (row.backfill_progress as BackfillProgress | null) ?? null;
      continue;
    }
    sources.push({
      source: row.source,
      watermark: row.watermark,
      last_success_at: toMs(row.last_success_at),
      last_error: row.last_error,
      consecutive_failures: toNumOr(row.consecutive_failures, 0),
      rows_last_poll: toNum(row.rows_last_poll),
      duration_ms_last_poll: toNum(row.duration_ms_last_poll),
    });
  }
  return { sources, backfill };
}

export async function listSyncLog(db: Db, limit: number): Promise<SyncLogEntry[]> {
  const { rows } = await db.query<{
    id: number;
    source: string;
    started_at: Date;
    finished_at: Date | null;
    rows: number | null;
    ingested: number | null;
    skipped: number | null;
    status: 'ok' | 'error' | 'running';
    error: string | null;
  }>(
    `SELECT id, source, started_at, finished_at, rows, ingested, skipped, status, error
     FROM sync_log ORDER BY started_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    source: r.source,
    started_at: toMsOr(r.started_at, 0),
    finished_at: toMs(r.finished_at),
    rows: toNum(r.rows),
    ingested: toNum(r.ingested),
    skipped: toNum(r.skipped),
    status: r.status,
    error: r.error,
  }));
}

/**
 * Persist `backfill_progress.requested_now = true` so the request survives a collector restart.
 * A finished backfill starts over (same reset as the collector's `requestNow`); one in progress
 * keeps its days and phase, which the collector derives from the counters, and one backing off
 * after failed chunks (`error`) tries the failed chunk again at once.
 */
export async function requestBackfillNow(db: Db): Promise<BackfillProgress> {
  const { rows } = await db.query<{ backfill_progress: BackfillProgress }>(
    `INSERT INTO sync_state (source, backfill_progress, updated_at)
     VALUES ($1, jsonb_build_object('status','scheduled','requested_now',true,'days_total',0,'days_done',0,
             'current_day',NULL,'started_at',NULL,'finished_at',NULL,'error',NULL,
             'first_day',NULL,'standards_done',false,'recolor_days_done',0), now())
     ON CONFLICT (source) DO UPDATE
       SET backfill_progress = COALESCE(sync_state.backfill_progress, '{}'::jsonb)
             || CASE WHEN sync_state.backfill_progress->>'status' = 'done'
                  THEN jsonb_build_object('days_done', 0, 'finished_at', NULL, 'error', NULL,
                         'first_day', NULL, 'standards_done', false, 'recolor_days_done', 0, 'failures', 0)
                  ELSE '{}'::jsonb END
             || jsonb_build_object('requested_now', true, 'status', 'scheduled', 'retry_at', NULL),
           updated_at = now()
     RETURNING backfill_progress`,
    [BACKFILL_SOURCE],
  );
  return rows[0].backfill_progress;
}
