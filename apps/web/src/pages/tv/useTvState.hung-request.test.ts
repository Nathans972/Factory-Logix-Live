/**
 * A TV request that the network never answers (half-open connection after a Wi-Fi blip or a
 * sleep/wake, or an API that stalls behind nginx's 3600 s proxy_read_timeout) must not stop the TV
 * from polling again. `useTvState` allows one request in flight and `ApiDataSource` sets no
 * timeout, so a single hung request would disable the 60 s poll, the hour roll and every SSE
 * refetch until it ends, with no "Dashboard offline" banner.
 *
 * The web tests run in plain node (no DOM, no react-test-renderer), so this file runs the real
 * `useTvState` and the real `ApiDataSource` on a minimal hook runtime (state, ref, memoised
 * callbacks, effects with dependency lists) and a stubbed `fetch` / fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TvDashboard, TvState } from '@fld/shared';
import { ApiDataSource } from '../../data/api/ApiDataSource';

const rt = vi.hoisted(() => {
  type Cell = { value?: unknown; current?: unknown; fn?: unknown; deps?: unknown[]; cleanup?: unknown };
  const st = { slots: [] as Cell[], cursor: 0, dirty: false, pending: [] as Array<() => void>, ds: null as unknown };
  const same = (a?: unknown[], b?: unknown[]): boolean =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial: unknown) {
      const slot = st.cursor++;
      if (st.slots[slot] === undefined) st.slots[slot] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      const cell = st.slots[slot]!;
      const set = (v: unknown): void => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(cell.value) : v;
        if (!Object.is(next, cell.value)) {
          cell.value = next;
          st.dirty = true;
        }
      };
      return [cell.value, set];
    },
    useRef(initial: unknown) {
      const slot = st.cursor++;
      if (st.slots[slot] === undefined) st.slots[slot] = { current: initial };
      return st.slots[slot];
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const slot = st.cursor++;
      const prev = st.slots[slot];
      if (prev !== undefined && same(prev.deps, deps)) return prev.fn;
      st.slots[slot] = { fn, deps };
      return fn;
    },
    useEffect(run: () => unknown, deps: unknown[]) {
      const slot = st.cursor++;
      const prev = st.slots[slot];
      if (prev !== undefined && same(prev.deps, deps)) return;
      st.pending.push(() => {
        const old = st.slots[slot]?.cleanup;
        if (typeof old === 'function') old();
        const cleanup = run();
        st.slots[slot] = { deps, cleanup };
      });
    },
  };
  /** Render the hook, commit its effects, and render again while a state setter ran. */
  function render<T>(hook: () => T): T {
    let out!: T;
    do {
      st.cursor = 0;
      st.dirty = false;
      st.pending = [];
      out = hook();
      for (const effect of st.pending) effect();
    } while (st.dirty);
    return out;
  }
  function unmount(): void {
    for (const cell of st.slots) if (cell && typeof cell.cleanup === 'function') (cell.cleanup as () => void)();
    st.slots = [];
  }
  return { st, hooks, render, unmount };
});

vi.mock('react', () => ({ ...rt.hooks, default: rt.hooks }));
vi.mock('../../data', () => ({ IS_MOCK: false }));
vi.mock('../../data/DataSourceContext', () => ({ useDataSource: () => rt.st.ds }));

import { useTvState } from './useTvState';

const MINUTE = 60_000;

function dashboard(qtyComplete: number): TvDashboard {
  return {
    job: { job_number: 'J1', product_number: 'Z1', product_name: 'Board', qty_released: 500, qty_complete: qtyComplete, progress: qtyComplete / 500 },
    grouped: false,
    show_std_day: true,
    columns: [],
    rows: [],
    defect_rows: [],
    generated_at: Date.now(),
  };
}

function tvState(qtyComplete: number): TvState {
  return {
    status: 'assigned',
    device_token: '00000000-0000-4000-8000-000000000001',
    pairing_code: '1234',
    display: {
      id: 1, pairing_code: '1234', name: 'Line 1', claimed_at: 1, job_number: 'J1', group_operators: false,
      show_std_day: true, show_gauge: true, shift_length_hours: 12, last_seen_at: Date.now(), created_at: 1, online: true,
    },
    dashboard: dashboard(qtyComplete),
    job_status: 'ok',
    sync: { status: 'ok', delayed: false, delayed_since: null, last_success_at: Date.now() },
    server_time: Date.now(),
    plant_timezone: 'America/New_York',
    admin_url: 'http://plant/admin',
  };
}

describe('TV polling when one request never completes', () => {
  let qtyComplete = 10;
  let hang = false;
  let gets = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T14:00:30Z'));
    qtyComplete = 10;
    hang = false;
    gets = 0;
    // Node's AbortSignal.timeout uses an internal timer that fake timers cannot drive.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal('window', {
      location: { search: '' },
      setInterval: (...a: Parameters<typeof setInterval>) => globalThis.setInterval(...a),
      clearInterval: (...a: Parameters<typeof clearInterval>) => globalThis.clearInterval(...a),
      setTimeout: (...a: Parameters<typeof setTimeout>) => globalThis.setTimeout(...a),
      clearTimeout: (...a: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...a),
    });
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') gets += 1;
      if (hang && (init?.method ?? 'GET') === 'GET') {
        // The network never answers; a request that has an abort signal still honours it.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')));
        });
      }
      return Promise.resolve(new Response(JSON.stringify(tvState(qtyComplete)), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    rt.st.ds = new ApiDataSource('/api');
  });

  afterEach(() => {
    rt.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks again after a poll that never completes, instead of showing stale numbers forever', async () => {
    const read = (): ReturnType<typeof useTvState> => rt.render(useTvState);

    read();
    await vi.advanceTimersByTimeAsync(100);
    expect(read().dashboard?.job.qty_complete).toBe(10);

    // t = 60 s: the poll's GET /state is sent and the connection silently dies.
    hang = true;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(gets).toBe(1);

    // The network is back and production moves on, but the hung request is never answered.
    hang = false;
    qtyComplete = 99;
    for (let minute = 0; minute < 10; minute += 1) await vi.advanceTimersByTimeAsync(MINUTE);

    // Ten more minutes of 60 s polls, hour ticks and SSE events: the TV must have asked again.
    expect(gets).toBeGreaterThan(1);
    expect(read().dashboard?.job.qty_complete).toBe(99);
  });
});
