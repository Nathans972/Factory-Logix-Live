/**
 * The collector keeps the outcome of its standards recomputes in sync_state('standards_recompute'),
 * so Admin > Sync lists it with the data sources. It is not a poll: when collector_state has no last
 * success (no poll has ever gone through), a recompute that did must not stand in for one.
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { buildSyncHealth } from '../src/services/sync-health.js';

const NOW = Date.parse('2026-06-02T06:05:00Z');
const TWO_MINUTES_AGO = new Date(NOW - 2 * 60_000);

function source(name: string, lastSuccessAt: Date | null) {
  return {
    source: name,
    watermark: null,
    last_success_at: lastSuccessAt,
    last_error: null,
    consecutive_failures: 0,
    rows_last_poll: 0,
    duration_ms_last_poll: 10,
    backfill_progress: null,
  };
}

/** settings, collector_state and sync_state as the api reads them, for a collector whose polls never went through. */
function database(sources: ReturnType<typeof source>[]): Db {
  const collector = {
    heartbeat_at: new Date(NOW - 10_000),
    breaker_open_until: new Date(NOW + 60_000),
    status: 'down',
    last_error: 'FactoryLogix did not answer',
    last_success_at: null,
    consecutive_failures: 4,
    last_standards_recompute_at: TWO_MINUTES_AGO,
  };
  return {
    async query(text: string) {
      if (text.includes('FROM settings')) return { rows: [] } as never;
      if (text.includes('FROM collector_state')) return { rows: [collector] } as never;
      if (text.includes('FROM sync_state')) return { rows: sources } as never;
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

describe('sync health with a standards_recompute row', () => {
  it('control: a data source that polled stands in for the missing last success', async () => {
    const health = await buildSyncHealth(database([source('work_orders', TWO_MINUTES_AGO)]), NOW);
    expect(health.last_success_at).toBe(TWO_MINUTES_AGO.getTime());
    expect(health.delayed).toBe(false);
  });

  it('lists the standards recompute, but does not take its success for a poll', async () => {
    const health = await buildSyncHealth(database([source('standards_recompute', TWO_MINUTES_AGO), source('work_orders', null)]), NOW);
    expect(health.sources.map((s) => s.source)).toEqual(['standards_recompute', 'work_orders']);
    expect(health.last_success_at).toBeNull();
    expect(health.delayed).toBe(true);
    expect(health.delayed_since).toBeNull();
  });
});
