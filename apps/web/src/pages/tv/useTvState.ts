/**
 * TV lifecycle hook (spec 8.1, 8.2, 8.4).
 *
 * - resolves the device identity once and registers with the backend on mount
 * - refetches `tvState` every 60 s and on `data_updated` / `display_updated` / `sync_health`
 * - re-renders at the top of every plant-local hour so the rolling window rolls without data
 * - keeps the last good dashboard while refetching (no flicker) and tracks the offline/delayed
 *   banner timestamps
 *
 * `useLive.ts` is owned by another agent; this hook subscribes to the DataSource directly so the
 * TV has no dependency on it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SseEvent, TvDashboard, TvState } from '@fld/shared';
import { IS_MOCK } from '../../data';
import { useDataSource } from '../../data/DataSourceContext';
import { getDeviceToken, msUntilNextHour, nextDashboard } from './tvLogic';

/** Fallback poll interval (spec 8.4: 60 s when SSE is unavailable). */
const POLL_MS = 60_000;

const REFETCH_ON: SseEvent['type'][] = ['data_updated', 'display_updated', 'sync_health'];

export interface TvViewState {
  token: string;
  /** last successful state; kept while a refetch is in flight or failing */
  state: TvState | null;
  /** last rendered dashboard; survives a backend outage (spec 8.2) */
  dashboard: TvDashboard | null;
  /** plant time zone; the browser zone until the first response arrives */
  tz: string;
  /** plant-clock time of the last successful refresh */
  updatedAt: number | null;
  /** time of the FIRST failed fetch in the current outage, else null */
  offlineSince: number | null;
  /** `sync.delayed_since` while the collector is behind, else null */
  delayedSince: number | null;
  delayed: boolean;
  /** true until the first response (success or failure) */
  loading: boolean;
  /** increments at every local hour boundary to force a re-render */
  hourTick: number;
}

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function useTvState(): TvViewState {
  const ds = useDataSource();
  const [token] = useState(() => getDeviceToken(IS_MOCK));
  const [state, setState] = useState<TvState | null>(null);
  const [dashboard, setDashboard] = useState<TvDashboard | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [hourTick, setHourTick] = useState(0);

  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const offlineRef = useRef<number | null>(null);

  const apply = useCallback((next: TvState) => {
    if (!aliveRef.current) return;
    setState(next);
    // Only a successful response changes the dashboard, so an outage leaves the last one on
    // screen (spec 8.2) while an admin job change swaps it on the next fetch.
    setDashboard((prev) => nextDashboard(prev, next));
    setUpdatedAt(next.server_time || Date.now());
    offlineRef.current = null;
    setOfflineSince(null);
    setLoading(false);
  }, []);

  const fail = useCallback(() => {
    if (!aliveRef.current) return;
    if (offlineRef.current == null) {
      offlineRef.current = Date.now();
      setOfflineSince(offlineRef.current);
    }
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await ds.tvState(token);
      apply(next);
    } catch {
      fail();
    } finally {
      inFlightRef.current = false;
    }
  }, [ds, token, apply, fail]);

  // Register on mount (also acts as the first poll + heartbeat), then poll and subscribe.
  useEffect(() => {
    aliveRef.current = true;

    void (async () => {
      try {
        const first = await ds.tvRegister(token);
        apply(first);
      } catch {
        fail();
        void refresh();
      }
    })();

    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const unsubscribe = ds.subscribe((e) => {
      if (REFETCH_ON.includes(e.type)) void refresh();
    });

    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [ds, token, apply, fail, refresh]);

  const tz = state?.plant_timezone || browserTz();

  // Top-of-the-hour re-render so the 12-hour window rolls without a data event (spec 8.4).
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setHourTick((t) => t + 1);
        void refresh();
        schedule();
      }, msUntilNextHour(Date.now(), tz));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [tz, refresh]);

  return {
    token,
    state,
    dashboard,
    tz,
    updatedAt,
    offlineSince,
    delayedSince: state?.sync.delayed ? (state.sync.delayed_since ?? state.sync.last_success_at ?? null) : null,
    delayed: Boolean(state?.sync.delayed),
    loading,
    hourTick,
  };
}
