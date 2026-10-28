/**
 * Historical backfill (spec 4.7): oldest first, one local day per chunk, inside the configured
 * off-shift window unless an admin asked for it now. Progress lives in
 * sync_state('backfill').backfill_progress so it resumes after a restart.
 *
 * Two phases. Download: pull each day and recompute its hour cells (counts appear early, but
 * no standards exist yet, so the cells have no color). Recoloring: run the standards recompute
 * once, then recompute the hour cells of every backfilled day again, one day per chunk, so the
 * history gets standards and colors.
 */
import { addDays, inLocalWindow, localDateString, localToUtc } from '@fld/engine';
import type { BackfillProgress, MappingConfig, Settings } from '@fld/shared';
import type { Pool } from '../db.js';
import type { Logger } from '../logger.js';
import type { Recomputer } from '../engine/recompute.js';
import type { Poller } from './poller.js';
import { loadBackfillProgress, saveBackfillProgress } from './state.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Runs the full standards recompute between the download and the recoloring phase. */
export type StandardsRunner = (settings: Settings, mapping: MappingConfig, now: number) => Promise<void>;

export interface TickResult {
  worked: boolean;
  /** The whole backfill (download and recoloring) just finished. */
  finished: boolean;
}

export function emptyProgress(daysTotal: number): BackfillProgress {
  return {
    status: 'scheduled',
    requested_now: false,
    days_total: daysTotal,
    days_done: 0,
    current_day: null,
    started_at: null,
    finished_at: null,
    error: null,
    first_day: null,
    standards_done: false,
    recolor_days_done: 0,
  };
}

export function dayBounds(tz: string, date: string): { from: number; to: number } {
  const [y, m, d] = date.split('-').map(Number);
  const from = localToUtc(tz, { year: y as number, month: m as number, day: d as number, hour: 0, minute: 0, second: 0 });
  const next = addDays(date, 1);
  const [ny, nm, nd] = next.split('-').map(Number);
  const to = localToUtc(tz, { year: ny as number, month: nm as number, day: nd as number, hour: 0, minute: 0, second: 0 });
  return { from, to };
}

function hoursOf(tz: string, day: string): number[] {
  const { from, to } = dayBounds(tz, day);
  const hours: number[] = [];
  for (let h = from; h < to; h += HOUR_MS) hours.push(h);
  return hours;
}

export class Backfill {
  private progress: BackfillProgress | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
    private readonly poller: Pick<Poller, 'pullWindow'>,
    private readonly recomputer: Pick<Recomputer, 'recomputeHours'>,
    private readonly runStandards: StandardsRunner,
  ) {}

  get current(): BackfillProgress | null {
    return this.progress;
  }

  async load(): Promise<BackfillProgress | null> {
    this.progress = await loadBackfillProgress(this.pool);
    return this.progress;
  }

  /** First run: schedule the backfill so it starts in the next off-shift window. */
  async ensureScheduled(settings: Settings): Promise<BackfillProgress> {
    if (!this.progress) await this.load();
    if (!this.progress) {
      this.progress = emptyProgress(settings.backfill_days);
      if (settings.backfill_days <= 0) {
        this.progress.status = 'done';
        this.progress.finished_at = Date.now();
      }
      await saveBackfillProgress(this.pool, this.progress);
      this.log.info({ days: settings.backfill_days }, 'backfill scheduled');
    }
    return this.progress;
  }

  isActive(): boolean {
    const status = this.progress?.status;
    return status === 'scheduled' || status === 'running' || status === 'paused' || status === 'recoloring';
  }

  /** True when the backfill may process a chunk right now. */
  shouldRun(settings: Settings, now: number): boolean {
    if (!this.isActive()) return false;
    if (this.progress?.requested_now) return true;
    return inLocalWindow(settings.plant_timezone, now, settings.backfill_window.start, settings.backfill_window.end);
  }

  async requestNow(): Promise<void> {
    if (!this.progress) await this.load();
    if (!this.progress) return;
    if (this.progress.status === 'done' || this.progress.status === 'error') {
      this.progress = {
        ...this.progress,
        status: 'scheduled',
        days_done: 0,
        finished_at: null,
        error: null,
        first_day: null,
        standards_done: false,
        recolor_days_done: 0,
      };
    }
    this.progress.requested_now = true;
    await saveBackfillProgress(this.pool, this.progress);
  }

  private async persist(): Promise<void> {
    if (this.progress) await saveBackfillProgress(this.pool, this.progress);
  }

  /** Mark as paused when we are outside the window (spec 4.7). The next tick resumes the right phase. */
  async pause(): Promise<void> {
    if (!this.progress || this.progress.status === 'paused' || !this.isActive()) return;
    this.progress.status = 'paused';
    await this.persist();
  }

  /**
   * Process exactly one chunk: one downloaded day, the standards recompute, or one re-colored
   * day. Returns whether work was done and whether the whole backfill just finished.
   */
  async tick(mapping: MappingConfig, settings: Settings, now: number): Promise<TickResult> {
    if (!this.progress) await this.load();
    if (!this.progress || !this.isActive()) return { worked: false, finished: false };
    const progress = this.progress;

    const tz = settings.plant_timezone;
    if (progress.days_total !== settings.backfill_days && progress.days_done === 0) {
      progress.days_total = settings.backfill_days;
    }
    // The range is fixed when the first day is processed; counting from `now` on every chunk
    // skipped a day each time the backfill ran across midnight. Progress saved before first_day
    // existed computes it once here and keeps it.
    if (!progress.first_day || progress.days_done === 0) {
      progress.first_day = localDateString(now - progress.days_total * DAY_MS, tz);
    }

    if (progress.days_done >= progress.days_total) return this.recolor(mapping, settings, now, progress.first_day);

    const day = addDays(progress.first_day, progress.days_done);
    const { from, to } = dayBounds(tz, day);

    if (progress.status !== 'running') {
      progress.status = 'running';
      progress.started_at = progress.started_at ?? now;
    }
    progress.current_day = day;
    progress.error = null;
    await this.persist();

    const touched: number[] = [];
    try {
      if (progress.days_done === 0) {
        // Every job changed since the first day. Open at the end: a job that changes while this
        // runs comes back at the end of the pull instead of leaving the window, so the poller
        // sees that it moved and reads again from where it was (`Poller.pullOrdered`).
        await this.poller.pullWindow('work_orders', mapping.work_orders, settings, {
          from,
          to: null,
          logSource: 'work_orders:backfill',
          touched,
        });
      }
      await this.poller.pullWindow('unit_steps', mapping.unit_steps, settings, { from, to, logSource: 'unit_steps:backfill', touched });
      if (mapping.defects) {
        await this.poller.pullWindow('defects', mapping.defects, settings, { from, to, logSource: 'defects:backfill', touched });
      }

      await this.recomputer.recomputeHours(hoursOf(tz, day), settings, now);

      progress.days_done += 1;
      if (progress.days_done >= progress.days_total) {
        progress.status = 'recoloring';
        progress.current_day = null;
        progress.standards_done = false;
        progress.recolor_days_done = 0;
      }
      await this.persist();
      this.log.info({ day, days_done: progress.days_done, days_total: progress.days_total }, 'backfill day complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress.error = message;
      await this.persist();
      this.log.error({ day, err: message }, 'backfill day failed');
    }
    return { worked: true, finished: false };
  }

  /** Recoloring phase: standards first, then one day of hour cells per chunk. */
  private async recolor(mapping: MappingConfig, settings: Settings, now: number, firstDay: string): Promise<TickResult> {
    const progress = this.progress as BackfillProgress;
    progress.status = 'recoloring';
    progress.started_at = progress.started_at ?? now;
    progress.error = null;
    const done = progress.recolor_days_done ?? 0;

    if (!progress.standards_done) {
      progress.current_day = null;
      await this.persist();
      try {
        await this.runStandards(settings, mapping, now);
        progress.standards_done = true;
        progress.recolor_days_done = done;
        await this.persist();
        this.log.info('standards recomputed after backfill; re-coloring backfilled days');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        progress.error = message;
        await this.persist();
        this.log.error({ err: message }, 'standards recompute after backfill failed');
      }
      return { worked: true, finished: false };
    }

    if (done >= progress.days_total) return this.finish(now);

    const day = addDays(firstDay, done);
    progress.current_day = day;
    await this.persist();
    try {
      await this.recomputer.recomputeHours(hoursOf(settings.plant_timezone, day), settings, now);
      progress.recolor_days_done = done + 1;
      await this.persist();
      this.log.info({ day, recolor_days_done: done + 1, days_total: progress.days_total }, 'backfill day re-colored');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress.error = message;
      await this.persist();
      this.log.error({ day, err: message }, 'backfill re-color failed');
      return { worked: true, finished: false };
    }

    if (done + 1 >= progress.days_total) return this.finish(now);
    return { worked: true, finished: false };
  }

  private async finish(now: number): Promise<TickResult> {
    if (!this.progress) return { worked: false, finished: false };
    this.progress.status = 'done';
    this.progress.finished_at = now;
    this.progress.requested_now = false;
    this.progress.current_day = null;
    await this.persist();
    this.log.info({ days: this.progress.days_done }, 'backfill complete');
    return { worked: true, finished: true };
  }
}
