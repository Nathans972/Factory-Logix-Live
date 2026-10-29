/**
 * Historical backfill (spec 4.7): oldest first, one local day per chunk, inside the configured
 * off-shift window unless an admin asked for it now. Progress lives in
 * sync_state('backfill').backfill_progress so it resumes after a restart.
 *
 * Two phases. Download: pull each day and recompute its hour cells (counts appear early, but
 * no standards exist yet, so the cells have no color). Recoloring: run the standards recompute
 * once, then recompute the hour cells of every backfilled day again, one day per chunk, so the
 * history gets standards and colors.
 *
 * A chunk that fails is tried again after the pause, but not for ever: after
 * `breaker_failure_threshold` failures in a row the backfill shows `error` and backs off as the
 * poll's breaker does (spec 4.6), until a chunk goes through or an admin runs it now.
 */
import { addDays, inLocalWindow, localDateString, localToUtc, nextLocalTime, utcToLocalParts } from '@fld/engine';
import type { BackfillProgress, MappingConfig, Settings } from '@fld/shared';
import type { Pool } from '../db.js';
import { errorMessage, type Logger } from '../logger.js';
import type { Recomputer } from '../engine/recompute.js';
import { backoffMs } from './breaker.js';
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
  /** Why the day being downloaded failed, if it did. */
  error?: unknown;
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
    failures: 0,
    retry_at: null,
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

/** HH:MM in `tz`. */
function clockTime(utcMs: number, tz: string): string {
  const { hour, minute } = utcToLocalParts(utcMs, tz);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A chunk went through: the failed attempts before it no longer count. */
function clearFailures(progress: BackfillProgress): void {
  progress.failures = 0;
  progress.retry_at = null;
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

  /** Not finished yet. `error` is too: it tries the failed chunk again once its backoff is over. */
  isActive(): boolean {
    const status = this.progress?.status;
    return status === 'scheduled' || status === 'running' || status === 'paused' || status === 'recoloring' || status === 'error';
  }

  /** True when the backfill may process a chunk right now. */
  shouldRun(settings: Settings, now: number): boolean {
    if (!this.isActive()) return false;
    // Backing off after failed chunks (`failed`), even when an admin ran it now.
    const retryAt = this.progress?.retry_at;
    if (retryAt && now < retryAt) return false;
    if (this.progress?.requested_now) return true;
    return inLocalWindow(settings.plant_timezone, now, settings.backfill_window.start, settings.backfill_window.end);
  }

  /**
   * "Run backfill now": a finished backfill starts over; one in progress goes on outside the
   * window, and one backing off after failed chunks (`error`) tries the failed chunk again at once.
   */
  async requestNow(): Promise<void> {
    if (!this.progress) await this.load();
    if (!this.progress) return;
    if (this.progress.status === 'done') {
      this.progress = {
        ...this.progress,
        status: 'scheduled',
        days_done: 0,
        finished_at: null,
        error: null,
        first_day: null,
        standards_done: false,
        recolor_days_done: 0,
        failures: 0,
      };
    } else if (this.progress.status === 'error') {
      this.progress.status = 'scheduled';
    }
    this.progress.retry_at = null;
    this.progress.requested_now = true;
    await saveBackfillProgress(this.pool, this.progress);
  }

  private async persist(): Promise<void> {
    if (this.progress) await saveBackfillProgress(this.pool, this.progress);
  }

  /**
   * Mark as paused when we are outside the window (spec 4.7). The next tick resumes the right phase.
   * A backfill backing off after failed chunks keeps showing `error` while it waits.
   */
  async pause(): Promise<void> {
    if (!this.progress || this.progress.status === 'paused' || this.progress.status === 'error' || !this.isActive()) return;
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
        await this.pullWhole(day, 'work_orders', mapping.work_orders, settings, {
          from,
          to: null,
          logSource: 'work_orders:backfill',
          touched,
        });
      }
      await this.pullWhole(day, 'unit_steps', mapping.unit_steps, settings, { from, to, logSource: 'unit_steps:backfill', touched });
      if (mapping.defects) {
        await this.pullWhole(day, 'defects', mapping.defects, settings, { from, to, logSource: 'defects:backfill', touched });
      }

      await this.recomputer.recomputeHours(hoursOf(tz, day), settings, now);

      progress.days_done += 1;
      clearFailures(progress);
      if (progress.days_done >= progress.days_total) {
        progress.status = 'recoloring';
        progress.current_day = null;
        progress.standards_done = false;
        progress.recolor_days_done = 0;
      }
      await this.persist();
      this.log.info({ day, days_done: progress.days_done, days_total: progress.days_total }, 'backfill day complete');
    } catch (err) {
      await this.failed(err, settings, 'backfill day failed', { day });
      return { worked: true, finished: false, error: err };
    }
    return { worked: true, finished: false };
  }

  /**
   * One window pull of the day being downloaded. A pull that comes back `truncated` stopped with
   * rows of its window still unread: the day was not read whole, so it fails and is tried again
   * instead of counting as downloaded.
   */
  private async pullWhole(day: string, ...pull: Parameters<Poller['pullWindow']>): Promise<void> {
    const result = await this.poller.pullWindow(...pull);
    if (result.truncated) {
      throw new Error(`${pull[0]}: the window pull stopped at the page cap with rows still to read, so ${day} was not read whole. Raise poll_page_size`);
    }
  }

  /**
   * A chunk failed: the next pass tries it again after the pause, but not for ever. Each attempt
   * downloads the day again from FactoryLogix (or recomputes the standards again), so after
   * `breaker_failure_threshold` failures in a row the backfill shows `error` and backs off as the
   * poll's breaker does (spec 4.6): the next attempt after 2x the poll interval, then 4x, up to
   * `breaker_max_backoff_minutes`, still only inside the window unless an admin ran it now.
   */
  private async failed(err: unknown, settings: Settings, what: string, context: Record<string, unknown> = {}): Promise<void> {
    const progress = this.progress as BackfillProgress;
    const message = errorMessage(err);
    const failures = (progress.failures ?? 0) + 1;
    progress.failures = failures;
    progress.error = message;
    progress.retry_at = null;
    if (failures >= settings.breaker_failure_threshold) {
      const tz = settings.plant_timezone;
      const { start, end } = settings.backfill_window;
      const retryAt =
        Date.now() +
        backoffMs(failures, {
          threshold: settings.breaker_failure_threshold,
          maxBackoffMinutes: settings.breaker_max_backoff_minutes,
          intervalMs: settings.poll_interval_seconds * 1_000,
        });
      // Outside the window the next try waits for it to open, unless an admin ran the backfill now.
      const nextTry = progress.requested_now || inLocalWindow(tz, retryAt, start, end) ? retryAt : nextLocalTime(tz, start, retryAt);
      progress.status = 'error';
      progress.retry_at = retryAt;
      progress.error = `${message} (failed ${failures} times in a row); the collector tries again at ${clockTime(nextTry, tz)}, or at once on "Run backfill now"`;
    }
    await this.persist();
    this.log.error({ ...context, err: message, failures, retry_at: progress.retry_at ? new Date(progress.retry_at).toISOString() : null }, what);
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
        clearFailures(progress);
        await this.persist();
        this.log.info('standards recomputed after backfill; re-coloring backfilled days');
      } catch (err) {
        await this.failed(err, settings, 'standards recompute after backfill failed');
      }
      return { worked: true, finished: false };
    }

    if (done >= progress.days_total) return this.finish(now);

    const day = addDays(firstDay, done);
    progress.current_day = day;
    await this.persist();
    try {
      // Against the standards just computed, not the StdHr (often none) the downloaded hours were computed with.
      await this.recomputer.recomputeHours(hoursOf(settings.plant_timezone, day), settings, now, { currentStandards: true });
      progress.recolor_days_done = done + 1;
      clearFailures(progress);
      await this.persist();
      this.log.info({ day, recolor_days_done: done + 1, days_total: progress.days_total }, 'backfill day re-colored');
    } catch (err) {
      await this.failed(err, settings, 'backfill re-color failed', { day });
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
