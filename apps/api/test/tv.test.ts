import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type TvDashboard } from '@fld/shared';
import type { DisplayRow } from '../src/db/repo/displays.js';
import { notFound } from '../src/errors.js';

const buildDashboard = vi.fn();
vi.mock('../src/services/dashboard.js', () => ({ buildDashboard: (...args: unknown[]) => buildDashboard(...args) }));
vi.mock('../src/db/repo/settings.js', () => ({ getSettings: async () => DEFAULT_SETTINGS }));
vi.mock('../src/services/sync-health.js', () => ({
  buildSyncHealth: async () => ({ status: 'ok', delayed: false, delayed_since: null, last_success_at: 1 }),
}));

const { buildTvState } = await import('../src/services/tv.js');

const db = { query: async () => ({ rows: [], rowCount: 0 }) };
const NOW = Date.parse('2025-06-01T12:00:00Z');

function row(over: Partial<DisplayRow> = {}): DisplayRow {
  return {
    id: 1,
    pairing_code: '4821',
    device_token: 'tok',
    name: 'Line 3',
    claimed_at: new Date(NOW - 86_400_000),
    job_number: 'J-100',
    group_operators: false,
    show_std_day: true,
    show_gauge: true,
    shift_length_hours: 12,
    last_seen_at: new Date(NOW),
    created_at: new Date(NOW - 86_400_000),
    ...over,
  };
}

beforeEach(() => {
  buildDashboard.mockReset();
});

describe('buildTvState job_status', () => {
  it('is ok with a dashboard when the job builds', async () => {
    const dashboard = { job: { job_number: 'J-100' } } as unknown as TvDashboard;
    buildDashboard.mockResolvedValue(dashboard);
    const state = await buildTvState(db, row(), 'http://x/admin', {}, NOW);
    expect(state).toMatchObject({ status: 'assigned', job_status: 'ok', dashboard });
  });

  it('is not_found when the assigned job has no data yet', async () => {
    buildDashboard.mockRejectedValue(notFound('unknown job J-100'));
    const warn = vi.fn();
    const state = await buildTvState(db, row(), 'http://x/admin', { log: { warn } }, NOW);
    expect(state).toMatchObject({ status: 'assigned', job_status: 'not_found', dashboard: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('is error (and logged) when the dashboard cannot be built for another reason', async () => {
    buildDashboard.mockRejectedValue(new Error('engine exploded'));
    const warn = vi.fn();
    const state = await buildTvState(db, row(), 'http://x/admin', { log: { warn } }, NOW);
    expect(state).toMatchObject({ status: 'assigned', job_status: 'error', dashboard: null });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is null when no job is assigned or the TV is unclaimed', async () => {
    expect((await buildTvState(db, row({ job_number: null }), 'http://x/admin', {}, NOW)).job_status).toBeNull();
    expect((await buildTvState(db, row({ claimed_at: null }), 'http://x/admin', {}, NOW)).job_status).toBeNull();
    expect(buildDashboard).not.toHaveBeenCalled();
  });
});
