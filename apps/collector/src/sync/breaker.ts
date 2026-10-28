/**
 * Circuit breaker and backoff (spec 4.6).
 * After `breaker_failure_threshold` consecutive failures the poll interval is multiplied by
 * 2, then 4, then 8 ... capped at `breaker_max_backoff_minutes`. Any success resets it.
 * A refused login opens it at once, with no retry on a timer: the collector polls again once the
 * FactoryLogix connection is saved again (see `Collector.refusedLogin` in index.ts).
 */
import type { SyncStatus } from '@fld/shared';

export interface BreakerOptions {
  threshold: number;
  maxBackoffMinutes: number;
  intervalMs: number;
}

export function backoffMs(failures: number, opts: BreakerOptions): number {
  if (failures < opts.threshold) return opts.intervalMs;
  const steps = Math.min(failures - opts.threshold + 1, 20);
  const multiplier = 2 ** steps;
  return Math.min(opts.intervalMs * multiplier, Math.max(1, opts.maxBackoffMinutes) * 60_000);
}

export interface BreakerSnapshot {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  openUntil: number | null;
  everPolled: boolean;
  /** FactoryLogix refused the login: open, with no retry on a timer (see `recordLoginRefused`). */
  loginRefused: boolean;
}

export class CircuitBreaker {
  consecutiveFailures = 0;
  lastSuccessAt: number | null = null;
  lastError: string | null = null;
  openUntil: number | null = null;
  everPolled = false;
  loginRefused = false;

  hydrate(snapshot: Partial<BreakerSnapshot>): void {
    if (snapshot.consecutiveFailures !== undefined) this.consecutiveFailures = snapshot.consecutiveFailures;
    if (snapshot.lastSuccessAt !== undefined) this.lastSuccessAt = snapshot.lastSuccessAt;
    if (snapshot.lastError !== undefined) this.lastError = snapshot.lastError;
    if (snapshot.openUntil !== undefined) this.openUntil = snapshot.openUntil;
    this.everPolled = Boolean(this.lastSuccessAt !== null || this.consecutiveFailures > 0);
  }

  /**
   * `error` is an optional data source that failed while the required ones came in: the data is
   * current (no backoff, not delayed), but the status stays degraded and shows the error.
   */
  recordSuccess(now: number, error: string | null = null): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = now;
    this.lastError = error;
    this.openUntil = null;
    this.everPolled = true;
    this.loginRefused = false;
  }

  recordFailure(now: number, error: string, opts: BreakerOptions): void {
    this.consecutiveFailures += 1;
    this.lastError = error;
    this.everPolled = true;
    this.openUntil = this.consecutiveFailures >= opts.threshold ? now + backoffMs(this.consecutiveFailures, opts) : null;
    this.loginRefused = false;
  }

  /**
   * FactoryLogix refused the login. Asking again would get the same answer until someone changes
   * the login or the account, and every refused login counts towards locking the account: there
   * is no time for the next attempt (`openUntil` stays empty).
   */
  recordLoginRefused(error: string): void {
    this.consecutiveFailures += 1;
    this.lastError = error;
    this.everPolled = true;
    this.openUntil = null;
    this.loginRefused = true;
  }

  /** Delay until the next poll attempt. */
  nextDelayMs(opts: BreakerOptions): number {
    return backoffMs(this.consecutiveFailures, opts);
  }

  isOpen(now: number): boolean {
    return this.openUntil !== null && now < this.openUntil;
  }

  snapshot(): BreakerSnapshot {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      openUntil: this.openUntil,
      everPolled: this.everPolled,
      loginRefused: this.loginRefused,
    };
  }
}

/** True when the last successful poll is older than 3x the poll interval (spec 4.6). */
export function isDelayed(lastSuccessAt: number | null, now: number, intervalMs: number): boolean {
  if (lastSuccessAt === null) return true;
  return now - lastSuccessAt > 3 * intervalMs;
}

/**
 * ok        - last poll succeeded
 * degraded  - some failures (under threshold) or in backoff but with a recent success, or an
 *             optional data source failing while the required ones come in
 * down      - breaker open (or the login refused) and the last success is older than 3x the
 *             interval (or never)
 * never     - nothing has ever been polled (no mapping/connection yet)
 */
export function computeStatus(
  snapshot: BreakerSnapshot,
  now: number,
  opts: { threshold: number; intervalMs: number; configured: boolean },
): SyncStatus {
  if (!opts.configured) return 'never';
  if (!snapshot.everPolled && snapshot.lastSuccessAt === null) return 'never';
  const delayed = isDelayed(snapshot.lastSuccessAt, now, opts.intervalMs);
  const breakerOpen = snapshot.loginRefused || snapshot.consecutiveFailures >= opts.threshold;
  if (breakerOpen && delayed) return 'down';
  if (snapshot.consecutiveFailures > 0 || snapshot.lastError !== null || delayed) return 'degraded';
  return 'ok';
}
