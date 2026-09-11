/**
 * Live simulation scheduler (spec 12.4).
 *
 * Every 5 s of wall clock the scripted cast appends new unit scans up to the simulated
 * `now`. Simulated `now` IS real now (speed 1) so the TV clock and the hour columns match
 * reality; the hidden speed control multiplies the *rate of simulated events*, not the clock.
 *
 * Reviewer control: `window.__fldDemo = { setSpeed(n), getSpeed(), state() }`, and `?speed=`
 * is honoured on first load.
 */
import { hourStartUtc } from '@fld/engine';
import { DISPLAY_JOB_CHANGE_MS, type MockStore } from '../state';
import { FEATURED_JOB } from './world';

const HOUR = 3_600_000;
const TICK_MS = 5_000;
const HEARTBEAT_MS = 25_000;

export interface DemoControl {
  setSpeed(n: number): void;
  getSpeed(): number;
  state(): Record<string, unknown>;
  tick(): void;
  stop(): void;
}

function unref(t: unknown): void {
  const handle = t as { unref?: () => void };
  if (typeof handle?.unref === 'function') handle.unref();
}

export function readSpeedFromUrl(): number {
  if (typeof location === 'undefined') return 1;
  try {
    const raw = new URLSearchParams(location.search).get('speed');
    if (raw === null) return 1;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(60, n);
  } catch {
    return 1;
  }
}

export function startLiveSimulation(store: MockStore): DemoControl {
  let speed = readSpeedFromUrl();
  let ticking = false;

  const tick = (): void => {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const added = store.advanceTo(now, speed);
      store.checkSyncTransition();
      const hours = new Set<number>();
      for (const s of added) {
        hours.add(hourStartUtc(s.complete_ts ?? s.start_ts, store.tz));
      }
      if (hours.size === 0) hours.add(hourStartUtc(now, store.tz));
      store.emitDataUpdated([...hours].sort((a, b) => a - b));
    } catch (err) {
      // A simulation hiccup must never take the demo down.
      if (typeof console !== 'undefined') console.warn('[demo] tick failed', err);
    } finally {
      ticking = false;
    }
  };

  const timers: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];

  if (typeof window !== 'undefined') {
    const t = setInterval(tick, TICK_MS);
    unref(t);
    timers.push(t);
    const hb = setInterval(() => store.emit({ type: 'heartbeat', at: Date.now() }), HEARTBEAT_MS);
    unref(hb);
    timers.push(hb);

    // Scripted: display 3 is re-pointed at the featured job ~3 minutes after page load.
    const jobChange = setTimeout(() => {
      try {
        const display = store.displays.find((d) => d.id === 3);
        if (display && display.job_number !== FEATURED_JOB) {
          store.updateDisplay(3, { job_number: FEATURED_JOB });
        }
      } catch {
        /* ignore */
      }
    }, DISPLAY_JOB_CHANGE_MS);
    unref(jobChange);
    timeouts.push(jobChange);
  }

  const control: DemoControl = {
    setSpeed(n: number) {
      if (!Number.isFinite(n) || n <= 0) return;
      speed = Math.min(60, n);
      tick();
    },
    getSpeed: () => speed,
    tick,
    state() {
      const now = Date.now();
      return {
        company: 'Northbridge Circuit Assembly',
        featured_job: FEATURED_JOB,
        speed,
        now,
        plant_timezone: store.tz,
        current_hour_utc: hourStartUtc(now, store.tz),
        hours_of_history: Math.round((now - hourStartUtc(now, store.tz)) / HOUR),
        displays: store.displays.map((d) => ({
          id: d.id,
          code: d.pairing_code,
          name: d.name,
          job: d.job_number,
          grouped: d.group_operators,
        })),
      };
    },
    stop() {
      for (const t of timers) clearInterval(t);
      for (const t of timeouts) clearTimeout(t);
      timers.length = 0;
      timeouts.length = 0;
    },
  };

  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__fldDemo = control;
  }
  return control;
}
