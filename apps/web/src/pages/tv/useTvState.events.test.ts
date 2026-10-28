import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Display, SseEvent, TvState } from '@fld/shared';

// The same tiny hook runtime as useTvState.reregister.test.ts (the web tests have no DOM library):
// state lives in slots, setters write to them, effects run once after the first ("mount") render.
const runtime = vi.hoisted(() => ({
  slots: [] as unknown[],
  idx: 0,
  mounting: true,
  effects: [] as Array<() => void | (() => void)>,
}));
const ds = vi.hoisted(() => {
  const listeners: Array<(e: SseEvent) => void> = [];
  return {
    listeners,
    tvRegister: vi.fn(),
    tvState: vi.fn(),
    subscribe: (cb: (e: SseEvent) => void) => {
      listeners.push(cb);
      return () => undefined;
    },
  };
});

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = runtime.idx++;
    if (!(i in runtime.slots)) runtime.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init;
    return [
      runtime.slots[i],
      (next: unknown) => {
        runtime.slots[i] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(runtime.slots[i]) : next;
      },
    ];
  },
  useRef: (init: unknown) => {
    const i = runtime.idx++;
    if (!(i in runtime.slots)) runtime.slots[i] = { current: init };
    return runtime.slots[i];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void)) => {
    if (runtime.mounting) runtime.effects.push(fn);
  },
}));
vi.mock('../../data', () => ({ IS_MOCK: false }));
vi.mock('../../data/DataSourceContext', () => ({ useDataSource: () => ds }));

// Called outside a component on purpose, through the fake runtime above.
const { useTvState: runHook } = await import('./useTvState');

const display = (over: Partial<Display>): Display => ({
  id: 7,
  pairing_code: '4821',
  name: 'Line 3',
  claimed_at: 1,
  job_number: 'J-100',
  group_operators: false,
  show_std_day: true,
  show_gauge: true,
  shift_length_hours: 12,
  last_seen_at: 1,
  created_at: 1,
  online: true,
  ...over,
});

const tvState = (over: Partial<TvState>): TvState => ({
  status: 'assigned',
  device_token: '0b8d6f0e-2f0a-4c55-9d0c-3a1f6f1d7a11',
  pairing_code: '4821',
  display: display({}),
  dashboard: null,
  job_status: 'ok',
  sync: { status: 'ok', delayed: false, delayed_since: null, last_success_at: 1 },
  server_time: 1,
  plant_timezone: 'UTC',
  admin_url: 'http://plant/admin',
  ...over,
});

function render() {
  runtime.idx = 0;
  runtime.mounting = false;
  return runHook();
}

async function mount() {
  runtime.slots = [];
  runtime.idx = 0;
  runtime.effects = [];
  runtime.mounting = true;
  runHook();
  runtime.mounting = false;
  for (const effect of runtime.effects) effect();
  await vi.advanceTimersByTimeAsync(0);
}

async function emit(...events: SseEvent[]) {
  for (const e of events) for (const listener of ds.listeners) listener(e);
  await vi.advanceTimersByTimeAsync(0);
}

const displayUpdated = (display_id: number): SseEvent => ({ type: 'display_updated', at: 1, display_id });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    location: { search: '' },
    setInterval: (...a: Parameters<typeof setInterval>) => setInterval(...a),
    clearInterval: (...a: Parameters<typeof clearInterval>) => clearInterval(...a),
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (...a: Parameters<typeof clearTimeout>) => clearTimeout(...a),
  });
  ds.listeners.length = 0;
  ds.tvRegister.mockReset();
  ds.tvState.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TV page and live display events', () => {
  it('does not refetch when other TVs register, only when its own display changes', async () => {
    ds.tvRegister.mockResolvedValue(tvState({}));
    ds.tvState.mockResolvedValue(tvState({}));
    await mount();

    // Anyone on the LAN can register made-up TVs, and each new display is announced to every page.
    for (let id = 100; id < 200; id += 1) await emit(displayUpdated(id));
    expect(ds.tvState).not.toHaveBeenCalled();

    // A manager changes the job this TV shows.
    await emit(displayUpdated(7));
    expect(ds.tvState).toHaveBeenCalledTimes(1);

    await emit({ type: 'data_updated', at: 1, hours: [] });
    expect(ds.tvState).toHaveBeenCalledTimes(2);
  });

  it('follows a re-pair onto an existing display', async () => {
    // The TV lost its token and shows a new code on a temporary display.
    const temporary = display({ id: 9, pairing_code: '5150', name: null, claimed_at: null, job_number: null });
    ds.tvRegister.mockResolvedValue(tvState({ status: 'unclaimed', job_status: null, pairing_code: '5150', display: temporary }));
    await mount();

    // Admin > Displays > Re-pair moves the token onto display 7; the API announces both displays.
    ds.tvState.mockResolvedValue(tvState({ pairing_code: '5150', display: display({ pairing_code: '5150' }) }));
    await emit(displayUpdated(7), displayUpdated(9));
    expect(render().state?.status).toBe('assigned');

    ds.tvState.mockClear();
    await emit(displayUpdated(9));
    expect(ds.tvState).not.toHaveBeenCalled();
    await emit(displayUpdated(7));
    expect(ds.tvState).toHaveBeenCalledTimes(1);
  });
});
