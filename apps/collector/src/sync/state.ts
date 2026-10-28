/** sync_state / sync_log persistence (spec 6.1, 4.5). */
import type { BackfillProgress } from '@fld/shared';
import { exec, q1, toMs, type Queryable } from '../db.js';

export interface SyncStateRow {
  source: string;
  watermark: string | null;
  last_success_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  rows_last_poll: number | null;
  duration_ms_last_poll: number | null;
  backfill_progress: BackfillProgress | null;
}

interface RawSyncStateRow {
  source: string;
  watermark: string | null;
  last_success_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
  rows_last_poll: number | null;
  duration_ms_last_poll: number | null;
  backfill_progress: BackfillProgress | null;
}

export async function loadSyncState(db: Queryable, source: string): Promise<SyncStateRow | null> {
  const row = await q1<RawSyncStateRow & Record<string, unknown>>(
    db,
    `SELECT source, watermark, last_success_at, last_error, consecutive_failures, rows_last_poll, duration_ms_last_poll, backfill_progress
       FROM sync_state WHERE source = $1`,
    [source],
  );
  if (!row) return null;
  return {
    source: row.source,
    watermark: row.watermark,
    last_success_at: toMs(row.last_success_at),
    last_error: row.last_error,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    rows_last_poll: row.rows_last_poll === null ? null : Number(row.rows_last_poll),
    duration_ms_last_poll: row.duration_ms_last_poll === null ? null : Number(row.duration_ms_last_poll),
    backfill_progress: row.backfill_progress ?? null,
  };
}

export async function recordSyncSuccess(
  db: Queryable,
  source: string,
  opts: { watermark: string | null; rows: number; durationMs: number },
): Promise<void> {
  await exec(
    db,
    `INSERT INTO sync_state (source, watermark, last_success_at, last_error, consecutive_failures, rows_last_poll, duration_ms_last_poll, updated_at)
     VALUES ($1, $2, now(), NULL, 0, $3, $4, now())
     ON CONFLICT (source) DO UPDATE SET
       watermark = COALESCE(EXCLUDED.watermark, sync_state.watermark),
       last_success_at = now(),
       last_error = NULL,
       consecutive_failures = 0,
       rows_last_poll = EXCLUDED.rows_last_poll,
       duration_ms_last_poll = EXCLUDED.duration_ms_last_poll,
       updated_at = now()`,
    [source, opts.watermark, Math.trunc(opts.rows), Math.trunc(opts.durationMs)],
  );
}

/** `opts.watermark` also replaces the stored watermark (the late-data re-pull stores its attempt time). */
export async function recordSyncFailure(
  db: Queryable,
  source: string,
  error: string,
  durationMs: number,
  opts: { watermark?: string | null } = {},
): Promise<void> {
  await exec(
    db,
    `INSERT INTO sync_state (source, watermark, last_error, consecutive_failures, duration_ms_last_poll, updated_at)
     VALUES ($1, $4, $2, 1, $3, now())
     ON CONFLICT (source) DO UPDATE SET
       watermark = COALESCE(EXCLUDED.watermark, sync_state.watermark),
       last_error = EXCLUDED.last_error,
       consecutive_failures = sync_state.consecutive_failures + 1,
       duration_ms_last_poll = EXCLUDED.duration_ms_last_poll,
       updated_at = now()`,
    [source, error.slice(0, 2000), Math.trunc(durationMs), opts.watermark ?? null],
  );
}

export async function startSyncLog(db: Queryable, source: string): Promise<number | null> {
  const row = await q1<{ id: number }>(db, `INSERT INTO sync_log (source, status) VALUES ($1, 'running') RETURNING id`, [source]);
  return row ? Number(row.id) : null;
}

export async function finishSyncLog(
  db: Queryable,
  id: number | null,
  opts: { status: 'ok' | 'error'; rows: number; error?: string | null },
): Promise<void> {
  if (id === null) return;
  await exec(db, 'UPDATE sync_log SET finished_at = now(), rows = $2, status = $3, error = $4 WHERE id = $1', [
    id,
    Math.trunc(opts.rows),
    opts.status,
    opts.error ? opts.error.slice(0, 2000) : null,
  ]);
}

export async function saveBackfillProgress(db: Queryable, progress: BackfillProgress): Promise<void> {
  await exec(
    db,
    `INSERT INTO sync_state (source, backfill_progress, updated_at) VALUES ('backfill', $1, now())
     ON CONFLICT (source) DO UPDATE SET backfill_progress = EXCLUDED.backfill_progress, updated_at = now()`,
    [JSON.stringify(progress)],
  );
}

export async function loadBackfillProgress(db: Queryable): Promise<BackfillProgress | null> {
  const row = await loadSyncState(db, 'backfill');
  return row?.backfill_progress ?? null;
}
