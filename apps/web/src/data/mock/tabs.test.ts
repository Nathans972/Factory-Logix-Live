/**
 * The demo's displays are shared between browser tabs (./tabs.ts). Two MockDataSource instances
 * stand in for two tabs of one origin. Every instance in this file stays on the same channel, so
 * the tests read what a TV shows now (as the TV page does) rather than assume the ids they got.
 */
import { describe, expect, it } from 'vitest';
import { MockDataSource } from './MockDataSource';
import { FEATURED_JOB, JOBS } from './simulator/world';

/** Long enough for the other tabs to deliver (and to generate their world on the way). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

const OTHER_JOB = JOBS.find((j) => j.end_days_ago === null && j.job_number !== FEATURED_JOB)!.job_number;

const newToken = () => 'tv-' + Math.random().toString(36).slice(2);

describe('displays shared between demo tabs', () => {
  it('a tab opened after a change starts with it', async () => {
    const portal = new MockDataSource();
    await portal.setDisplayJob(1, { job_number: OTHER_JOB });
    await settle();

    const tv = new MockDataSource(); // opened later from the demo bar
    await settle();
    const state = await tv.tvState('demo-1');
    expect(state.display?.job_number).toBe(OTHER_JOB);
    expect(state.dashboard?.job.job_number).toBe(OTHER_JOB);
  });

  it('a TV registering before it hears from the other tabs keeps its code and undoes nothing', async () => {
    const portal = new MockDataSource();
    await portal.setDisplayJob(2, { job_number: OTHER_JOB });
    await settle();

    // The Help menu's TV page: it registers on load, before any other tab can answer.
    const tv = new MockDataSource();
    const token = newToken();
    const waiting = await tv.tvRegister(token);
    expect(waiting.status).toBe('unclaimed');
    await settle();

    expect((await tv.tvDisplays()).find((d) => d.id === 2)?.job_number).toBe(OTHER_JOB);
    expect((await portal.tvDisplays()).find((d) => d.id === 2)?.job_number).toBe(OTHER_JOB);
    expect((await tv.tvState(token)).pairing_code).toBe(waiting.pairing_code);

    await portal.claimDisplay({ pairing_code: waiting.pairing_code, name: 'Cell 4 TV', job_number: OTHER_JOB });
    await settle();
    const claimed = await tv.tvState(token);
    expect(claimed.status).toBe('assigned');
    expect(claimed.display?.name).toBe('Cell 4 TV');
    expect(claimed.dashboard?.job.job_number).toBe(OTHER_JOB);
  });

  it('a display deleted in one tab sends the TV in another back to a code that can be claimed', async () => {
    const admin = new MockDataSource();
    const tv = new MockDataSource();
    const token = newToken();
    await tv.tvRegister(token);
    await settle();
    let shown = await tv.tvState(token);
    await settle();

    const display = await admin.claimDisplay({ pairing_code: shown.pairing_code, name: 'Cell 5 TV', job_number: FEATURED_JOB });
    await settle();
    expect((await tv.tvState(token)).display).toMatchObject({ id: display.id, name: 'Cell 5 TV' });

    await admin.deleteDisplay(display.id);
    await settle();
    shown = await tv.tvState(token);
    expect(shown.status).toBe('unclaimed');
    expect(shown.display?.id).not.toBe(display.id);
    expect(shown.pairing_code).toMatch(/^\d{4}$/);
    await settle();

    await expect(admin.claimDisplay({ pairing_code: shown.pairing_code, name: 'Cell 5 TV' })).resolves.toMatchObject({
      id: shown.display!.id,
    });
  });
});
