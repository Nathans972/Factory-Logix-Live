/**
 * Historical backfill (spec 4.7): oldest first, one local day per chunk, inside the configured
 * off-shift window unless an admin asked for it now. Progress lives in
 * sync_state('backfill').backfill_progress so it resumes after a restart.
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

export class Backfill {
  private progress: BackfillProgress | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
    private readonly poller: Poller,
    private readonly recomputer: Recomputer,
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
    return status === 'scheduled' || status === 'running' || status === 'paused';
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
      this.progress = { ...this.progress, status: 'scheduled', days_done: 0, finished_at: null, error: null };
    }
    this.progress.requested_now = true;
    await saveBackfillProgress(this.pool, this.progress);
  }

  private async persist(): Promise<void> {
    if (this.progress) await saveBackfillProgress(this.pool, this.progress);
  }

  /** Mark as paused when we are outside the window (spec 4.7). */
  async pause(): Promise<void> {
    if (!this.progress || this.progress.status === 'paused' || !this.isActive()) return;
    this.progress.status = 'paused';
    await this.persist();
  }

  /**
   * Process exactly one day chunk. Returns whether work was done and whether the backfill
   * just finished (the caller then runs a full standards recompute).
   */
  async tick(mapping: MappingConfig, settings: Settings, now: number): Promise<{ worked: boolean; finished: boolean }> {
    if (!this.progress) await this.load();
    if (!this.progress || !this.isActive()) return { worked: false, finished: false };

    const tz = settings.plant_timezone;
    if (this.progress.days_total !== settings.backfill_days && this.progress.days_done === 0) {
      this.progress.days_total = settings.backfill_days;
    }
    if (this.progress.days_done >= this.progress.days_total) {
      return this.finish(now);
    }

    const firstDay = localDateString(now - this.progress.days_total * DAY_MS, tz);
    const day = addDays(firstDay, this.progress.days_done);
    const { from, to } = dayBounds(tz, day);

    if (this.progress.status !== 'running') {
      this.progress.status = 'running';
      this.progress.started_at = this.progress.started_at ?? now;
    }
    this.progress.current_day = day;
    this.progress.error = null;
    await this.persist();

    const touched: number[] = [];
    try {
      if (this.progress.days_done === 0) {
        await this.poller.pullWindow('work_orders', mapping.work_orders, settings, {
          from,
          to: now,
          logSource: 'work_orders:backfill',
          touched,
        });
      }
      await this.poller.pullWindow('unit_steps', mapping.unit_steps, settings, { from, to, logSource: 'unit_steps:backfill', touched });
      if (mapping.defects) {
        await this.poller.pullWindow('defects', mapping.defects, settings, { from, to, logSource: 'defects:backfill', touched });
      }

      const hours: number[] = [];
      for (let h = from; h < to; h += HOUR_MS) hours.push(h);
      await this.recomputer.recomputeHours(hours, settings, now);

      this.progress.days_done += 1;
      await this.persist();
      this.log.info({ day, days_done: this.progress.days_done, days_total: this.progress.days_total }, 'backfill day complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.progress.error = message;
      await this.persist();
      this.log.error({ day, err: message }, 'backfill day failed');
      return { worked: true, finished: false };
    }

    if (this.progress.days_done >= this.progress.days_total) return this.finish(now);
    return { worked: true, finished: false };
  }

  private async finish(now: number): Promise<{ worked: boolean; finished: boolean }> {
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
