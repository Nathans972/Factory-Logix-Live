/**
 * Spec 15 acceptance scenarios 14 and 15, played against the mock DataSource. Scenarios 1-13 are
 * engine tests (packages/engine/test/acceptance.test.ts).
 *
 * The TV page itself needs a browser (effects, timers, SSE), so these tests drive the same pure
 * pieces it is built from: the DataSource responses, `nextDashboard` / `tvScreen` / `tvDelay`
 * (what `useTvState` and `TvPage` do with them), `resolveDeviceToken`, and the rendered markup.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TvDashboard as TvDashboardData, TvState } from '@fld/shared';
import { formatTime24 } from '../../lib/format';
import { MockDataSource } from '../../data/mock/MockDataSource';
import { FEATURED_JOB } from '../../data/mock/simulator/world';
import { TvBanners } from './TvBanners';
import { TvDashboard } from './TvDashboard';
import { nextDashboard, resolveDeviceToken, tvDelay, tvScreen } from './tvLogic';

const MINUTE = 60_000;

/** What the TV renders for a view: banners plus either the dashboard or the message lines. */
function renderTv(view: { state: TvState | null; dashboard: TvDashboardData | null; token: string; offlineSince?: number | null }) {
  const tz = view.state?.plant_timezone ?? 'UTC';
  const delay = tvDelay(view.state);
  const banners = renderToStaticMarkup(
    createElement(TvBanners, { offlineSince: view.offlineSince ?? null, delayed: delay.delayed, delayedSince: delay.delayedSince, tz }),
  );
  const screen = tvScreen({ state: view.state, dashboard: view.dashboard, loading: false, token: view.token });
  const body =
    screen.kind === 'dashboard'
      ? renderToStaticMarkup(createElement(TvDashboard, { dashboard: screen.dashboard, showGauge: true, tz, updatedAt: view.state?.server_time ?? null }))
      : screen.lines.map((l) => l.text).join('\n');
  return { banners, body, screen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scenario 14: data delayed', () => {
  it('shows the delayed banner with the last success time, keeps the dashboard, and clears after a success', async () => {
    const boot = Date.now();
    const ds = new MockDataSource();
    const store = ds.store;
    const clock = vi.spyOn(store, 'now');

    // Healthy: dashboard, no banner.
    clock.mockReturnValue(boot + MINUTE);
    let state = await ds.tvRegister('demo-1');
    let dashboard = nextDashboard(null, state);
    let tv = renderTv({ state, dashboard, token: 'demo-1' });
    expect(tv.banners).toBe('');
    expect(tv.screen.kind).toBe('dashboard');
    expect(tv.body).toContain(FEATURED_JOB);

    // The demo's scripted episode: the collector misses polls 5-7 minutes after boot.
    clock.mockReturnValue(boot + 6 * MINUTE);
    vi.spyOn(Date, 'now').mockReturnValue(boot + 6 * MINUTE);
    state = await ds.tvState('demo-1');
    dashboard = nextDashboard(dashboard, state);
    expect(state.sync.delayed).toBe(true);
    const lastSuccess = state.sync.last_success_at!;
    tv = renderTv({ state, dashboard, token: 'demo-1' });
    expect(tv.banners).toContain(`Data delayed since ${formatTime24(lastSuccess, state.plant_timezone)}`);
    // The dashboard stays on screen underneath the banner.
    expect(tv.screen.kind).toBe('dashboard');
    expect(tv.body).toContain(FEATURED_JOB);

    // The next successful poll clears the banner.
    clock.mockReturnValue(boot + 8 * MINUTE);
    vi.spyOn(Date, 'now').mockReturnValue(boot + 8 * MINUTE);
    state = await ds.tvState('demo-1');
    dashboard = nextDashboard(dashboard, state);
    tv = renderTv({ state, dashboard, token: 'demo-1' });
    expect(state.sync.delayed).toBe(false);
    expect(tv.banners).toBe('');
    expect(tv.screen.kind).toBe('dashboard');
  });

  it('keeps the last dashboard on screen while the backend is unreachable', async () => {
    const ds = new MockDataSource();
    const state = await ds.tvRegister('demo-1');
    const dashboard = nextDashboard(null, state);
    // A failed fetch leaves state and dashboard untouched and only sets offlineSince.
    const offlineSince = Date.parse('2025-06-01T14:05:00Z');
    const tv = renderTv({ state, dashboard, token: 'demo-1', offlineSince });
    expect(tv.banners).toContain(`Dashboard offline since ${formatTime24(offlineSince, state.plant_timezone)}`);
    expect(tv.screen.kind).toBe('dashboard');
  });
});

describe('scenario 15: pairing', () => {
  it('shows a 4-digit code, renders the job once an admin claims it, and keeps its identity after a reload', async () => {
    const ds = new MockDataSource();

    // First boot: no stored token, so the TV generates one and persists it.
    const generated = '0f3a9c2e-5b1d-4e7a-9c2f-3a8b6d4e1f07';
    const first = resolveDeviceToken({ search: '', stored: null, isMock: false, generate: () => generated });
    expect(first).toEqual({ token: generated, persist: true, source: 'generated' });
    const token = first.token;

    let state = await ds.tvRegister(token);
    expect(state.status).toBe('unclaimed');
    expect(state.pairing_code).toMatch(/^\d{4}$/);
    let tv = renderTv({ state, dashboard: nextDashboard(null, state), token });
    expect(tv.body).toContain(state.pairing_code);
    expect(tv.body).toContain('Claim it in the admin portal.');

    // An admin claims the code, names the TV and assigns a job.
    const display = await ds.claimDisplay({ pairing_code: state.pairing_code, name: 'Line 9 TV', job_number: FEATURED_JOB });
    expect(display.name).toBe('Line 9 TV');

    // The next poll renders the dashboard.
    state = await ds.tvState(token);
    expect(state.status).toBe('assigned');
    tv = renderTv({ state, dashboard: nextDashboard(null, state), token });
    expect(tv.screen.kind).toBe('dashboard');
    expect(tv.body).toContain(FEATURED_JOB);

    // Reboot: the stored token wins, so the TV registers as the same, still-claimed display.
    const second = resolveDeviceToken({ search: '', stored: token, isMock: false, generate: () => 'tv-new-token' });
    expect(second).toMatchObject({ token, source: 'stored' });
    const afterReboot = await ds.tvRegister(second.token);
    expect(afterReboot.status).toBe('assigned');
    expect(afterReboot.display?.id).toBe(display.id);
    expect(afterReboot.display?.name).toBe('Line 9 TV');
    expect(afterReboot.pairing_code).toBe(state.pairing_code);
  });
});
