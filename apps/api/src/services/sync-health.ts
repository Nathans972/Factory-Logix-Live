import type { SyncHealth } from '@fld/shared';
import type { Db } from '../db/pool.js';
import { getSettings } from '../db/repo/settings.js';
import { getCollectorState, listSyncStates, STANDARDS_SOURCE } from '../db/repo/sync.js';

/** `SyncHealth` assembled from collector_state + sync_state + settings. */
export async function buildSyncHealth(db: Db, now = Date.now()): Promise<SyncHealth> {
  const [settings, state, { sources, backfill }] = await Promise.all([
    getSettings(db),
    getCollectorState(db),
    listSyncStates(db),
  ]);

  const pollIntervalSeconds = settings.poll_interval_seconds;
  const staleMs = pollIntervalSeconds * 3 * 1000;

  // A standards recompute that went through says nothing about how current the data is.
  const sourceSuccesses = sources
    .filter((s) => s.source !== STANDARDS_SOURCE)
    .map((s) => s.last_success_at)
    .filter((v): v is number => v !== null);
  const lastSuccessAt =
    state.last_success_at ?? (sourceSuccesses.length > 0 ? Math.max(...sourceSuccesses) : null);

  const collectorRunning = state.heartbeat_at !== null && now - state.heartbeat_at <= staleMs;
  const delayed = lastSuccessAt === null ? collectorRunning : now - lastSuccessAt > staleMs;

  return {
    status: state.status,
    last_success_at: lastSuccessAt,
    last_error: state.last_error,
    consecutive_failures: state.consecutive_failures,
    breaker_open_until: state.breaker_open_until,
    delayed,
    delayed_since: delayed ? lastSuccessAt : null,
    poll_interval_seconds: pollIntervalSeconds,
    sources,
    backfill,
    collector_running: collectorRunning,
  };
}
