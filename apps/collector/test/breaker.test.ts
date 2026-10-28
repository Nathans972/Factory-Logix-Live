import { describe, expect, it } from 'vitest';
import { CircuitBreaker, backoffMs, computeStatus, isDelayed } from '../src/sync/breaker.js';

const INTERVAL = 90_000;
const OPTS = { threshold: 3, maxBackoffMinutes: 10, intervalMs: INTERVAL };

describe('backoff schedule', () => {
  it('stays at the poll interval below the threshold', () => {
    expect(backoffMs(0, OPTS)).toBe(INTERVAL);
    expect(backoffMs(1, OPTS)).toBe(INTERVAL);
    expect(backoffMs(2, OPTS)).toBe(INTERVAL);
  });

  it('doubles from the threshold on and caps at breaker_max_backoff_minutes', () => {
    expect(backoffMs(3, OPTS)).toBe(2 * INTERVAL);
    expect(backoffMs(4, OPTS)).toBe(4 * INTERVAL);
    expect(backoffMs(5, OPTS)).toBe(Math.min(8 * INTERVAL, 600_000));
    expect(backoffMs(6, OPTS)).toBe(600_000);
    expect(backoffMs(50, OPTS)).toBe(600_000);
  });
});

describe('circuit breaker', () => {
  it('opens after the threshold and resets on success', () => {
    const breaker = new CircuitBreaker();
    const t0 = 1_000_000;
    breaker.recordFailure(t0, 'timeout', OPTS);
    breaker.recordFailure(t0 + 1, 'timeout', OPTS);
    expect(breaker.openUntil).toBeNull();
    expect(breaker.isOpen(t0 + 2)).toBe(false);

    breaker.recordFailure(t0 + 2, 'HTTP 500', OPTS);
    expect(breaker.consecutiveFailures).toBe(3);
    expect(breaker.openUntil).toBe(t0 + 2 + 2 * INTERVAL);
    expect(breaker.isOpen(t0 + 3)).toBe(true);
    expect(breaker.nextDelayMs(OPTS)).toBe(2 * INTERVAL);

    breaker.recordSuccess(t0 + 10);
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.openUntil).toBeNull();
    expect(breaker.lastError).toBeNull();
    expect(breaker.nextDelayMs(OPTS)).toBe(INTERVAL);
  });
});

describe('health status', () => {
  const now = 2_000_000;
  it('reports never until the collector is configured', () => {
    const breaker = new CircuitBreaker();
    expect(computeStatus(breaker.snapshot(), now, { threshold: 3, intervalMs: INTERVAL, configured: false })).toBe('never');
    expect(computeStatus(breaker.snapshot(), now, { threshold: 3, intervalMs: INTERVAL, configured: true })).toBe('never');
  });

  it('reports ok, degraded and down', () => {
    const breaker = new CircuitBreaker();
    breaker.recordSuccess(now - 1_000);
    expect(computeStatus(breaker.snapshot(), now, { threshold: 3, intervalMs: INTERVAL, configured: true })).toBe('ok');

    breaker.recordFailure(now, 'boom', OPTS);
    expect(computeStatus(breaker.snapshot(), now, { threshold: 3, intervalMs: INTERVAL, configured: true })).toBe('degraded');

    const stale = new CircuitBreaker();
    stale.hydrate({ consecutiveFailures: 5, lastSuccessAt: now - 10 * INTERVAL, lastError: 'boom' });
    expect(computeStatus(stale.snapshot(), now, { threshold: 3, intervalMs: INTERVAL, configured: true })).toBe('down');
  });

  it('stays current but degraded while an optional data source fails', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i += 1) breaker.recordSuccess(now - 1_000, 'defects: OData request failed with HTTP 500');
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.nextDelayMs(OPTS)).toBe(INTERVAL);
    expect(isDelayed(breaker.lastSuccessAt, now, INTERVAL)).toBe(false);
    expect(computeStatus(breaker.snapshot(), now, { threshold: 3, intervalMs: INTERVAL, configured: true })).toBe('degraded');

    breaker.recordSuccess(now);
    expect(breaker.lastError).toBeNull();
    expect(computeStatus(breaker.snapshot(), now, { threshold: 3, intervalMs: INTERVAL, configured: true })).toBe('ok');
  });

  it('stays open after a restart until the persisted openUntil', () => {
    const restarted = new CircuitBreaker();
    restarted.hydrate({ consecutiveFailures: 4, lastSuccessAt: null, lastError: 'HTTP 503', openUntil: now + 60_000 });
    expect(restarted.isOpen(now)).toBe(true);
    expect(restarted.isOpen(now + 60_000)).toBe(false);
    const closed = new CircuitBreaker();
    closed.hydrate({ consecutiveFailures: 0, lastSuccessAt: now - 1_000, lastError: null, openUntil: null });
    expect(closed.isOpen(now)).toBe(false);
  });

  it('flags delay after 3x the poll interval', () => {
    expect(isDelayed(now - 2 * INTERVAL, now, INTERVAL)).toBe(false);
    expect(isDelayed(now - 4 * INTERVAL, now, INTERVAL)).toBe(true);
    expect(isDelayed(null, now, INTERVAL)).toBe(true);
  });
});
