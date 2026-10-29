/**
 * Red team (public demo): every browser tab builds its own in-memory `MockStore`
 * (`createDataSource()` in main.tsx), and the demo bar's "View TV display demo" link and the
 * Job page's "Open TV view" both open `/tv?demo=1` in a NEW tab (`target="_blank"`).
 *
 * The TV displays page tells the reviewer "The TV switches as soon as you save." In the
 * demo it never does when the TV is in its own tab: the portal tab changes its own copy of
 * the displays and the TV tab keeps showing the old job forever. Two MockDataSource
 * instances in one process stand in for the two tabs of one origin.
 */
import { describe, expect, it } from 'vitest';
import { MockDataSource } from './MockDataSource';
import { FEATURED_JOB, JOBS } from './simulator/world';

/** Give a cross-tab channel (BroadcastChannel, storage event, ...) time to deliver. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

describe('demo state across browser tabs', () => {
  it('a job changed on /displays reaches a TV that is open in another tab', async () => {
    const portalTab = new MockDataSource(); // /displays
    const tvTab = new MockDataSource(); // /tv?demo=1, opened from the demo bar

    const first = await tvTab.tvRegister('demo-1');
    expect(first.status).toBe('assigned');
    expect(first.display?.job_number).toBe(FEATURED_JOB);

    const other = JOBS.find((j) => j.end_days_ago === null && j.job_number !== FEATURED_JOB)!.job_number;
    const changed = await portalTab.setDisplayJob(first.display!.id, { job_number: other });
    expect(changed.job_number).toBe(other);

    await settle();
    const after = await tvTab.tvState('demo-1');
    expect(after.display?.job_number, 'the TV tab still shows the old job').toBe(other);
    expect(after.dashboard?.job.job_number).toBe(other);
  });

  it('a pairing code shown by a TV in one tab can be claimed in the Settings tab', async () => {
    const adminTab = new MockDataSource(); // /admin/displays
    const tvTab = new MockDataSource(); // /tv (no ?demo): shows a pairing code

    const waiting = await tvTab.tvRegister('reviewer-tv-' + Math.random().toString(36).slice(2));
    expect(waiting.status).toBe('unclaimed');
    expect(waiting.pairing_code).toMatch(/^\d{4}$/);

    await settle();
    // The README's TV setup: enter the code the TV shows. Today: "No TV is showing that code".
    await expect(
      adminTab.claimDisplay({ pairing_code: waiting.pairing_code, name: 'Cell 9 TV', job_number: FEATURED_JOB }),
    ).resolves.toMatchObject({ name: 'Cell 9 TV' });
  });
});
