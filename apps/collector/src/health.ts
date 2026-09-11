/**
 * collector_state heartbeat + health status (spec 4.6, 14).
 * Writes at least every 30 s and NOTIFYs `fld_sync_health` whenever the status changes.
 */
import type { SyncStatus } from '@fld/shared';
import { exec, notify, q1, toMs, type Pool } from './db.js';
import type { Logger } from './logger.js';
import { computeStatus, isDelayed, type BreakerSnapshot } from './sync/breaker.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface CollectorStateRow {
  heartbeat_at: number | null;
  breaker_open_until: number | null;
  status: SyncStatus;
  last_error: string | null;
  last_success_at: number | null;
  consecutive_failures: number;
  last_standards_recompute_at: number | null;
}

export class HealthReporter {
  private lastStatus: SyncStatus | null = null;
  private lastWriteAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
  ) {}

  async load(): Promise<CollectorStateRow | null> {
    const row = await q1<Record<string, unknown>>(
      this.pool,
      `SELECT heartbeat_at, breaker_open_until, status, last_error, last_success_at, consecutive_failures, last_standards_recompute_at
         FROM collector_state WHERE id = 1`,
    );
    if (!row) return null;
    return {
      heartbeat_at: toMs(row.heartbeat_at as Date | null),
      breaker_open_until: toMs(row.breaker_open_until as Date | null),
      status: (row.status as SyncStatus) ?? 'never',
      last_error: (row.last_error as string | null) ?? null,
      last_success_at: toMs(row.last_success_at as Date | null),
      consecutive_failures: Number(row.consecutive_failures ?? 0),
      last_standards_recompute_at: toMs(row.last_standards_recompute_at as Date | null),
    };
  }

  async ensureRow(): Promise<void> {
    await exec(this.pool, 'INSERT INTO collector_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  }

  /**
   * Persist the heartbeat and breaker state. Throttled to one write per 30 s unless the
   * status changed or `force` is set.
   */
  async report(opts: {
    snapshot: BreakerSnapshot;
    now: number;
    intervalMs: number;
    threshold: number;
    configured: boolean;
    force?: boolean;
  }): Promise<SyncStatus> {
    const status = computeStatus(opts.snapshot, opts.now, {
      threshold: opts.threshold,
      intervalMs: opts.intervalMs,
      configured: opts.configured,
    });
    const changed = status !== this.lastStatus;
    const due = opts.now - this.lastWriteAt >= HEARTBEAT_INTERVAL_MS;
    if (!changed && !due && !opts.force) return status;

    this.lastWriteAt = opts.now;
    try {
      await exec(
        this.pool,
        `UPDATE collector_state SET
           heartbeat_at = now(),
           breaker_open_until = $1,
           status = $2,
           last_error = $3,
           last_success_at = $4,
           consecutive_failures = $5,
           updated_at = now()
         WHERE id = 1`,
        [
          opts.snapshot.openUntil === null ? null : new Date(opts.snapshot.openUntil),
          status,
          opts.snapshot.lastError ? opts.snapshot.lastError.slice(0, 2000) : null,
          opts.snapshot.lastSuccessAt === null ? null : new Date(opts.snapshot.lastSuccessAt),
          opts.snapshot.consecutiveFailures,
        ],
      );
      if (changed) {
        const delayed = isDelayed(opts.snapshot.lastSuccessAt, opts.now, opts.intervalMs);
        await notify(this.pool, 'fld_sync_health', { status, delayed });
        this.log.info({ status, delayed, failures: opts.snapshot.consecutiveFailures }, 'sync health changed');
        this.lastStatus = status;
      }
    } catch (err) {
      this.log.error({ err }, 'could not write collector_state heartbeat');
    }
    if (changed) this.lastStatus = status;
    return status;
  }

  async setLastStandardsRecompute(at: number): Promise<void> {
    await exec(this.pool, 'UPDATE collector_state SET last_standards_recompute_at = $1, updated_at = now() WHERE id = 1', [new Date(at)]);
  }
}
