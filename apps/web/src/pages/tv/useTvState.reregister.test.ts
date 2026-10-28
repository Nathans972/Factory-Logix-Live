import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Display, TvState } from '@fld/shared';
import { DataSourceError } from '../../data/DataSource';

// The web tests have no DOM library, so run useTvState on a tiny hook runtime instead of React:
// state lives in slots, setters write to them, effects run once after the first ("mount") render.
const runtime = vi.hoisted(() => ({
  slots: [] as unknown[],
  idx: 0,
  mounting: true,
  effects: [] as Array<() => void | (() => void)>,
}));
const ds = vi.hoisted(() => ({
  tvRegister: vi.fn(),
  tvState: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

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
  name: null,
  claimed_at: null,
  job_number: null,
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
  status: 'unclaimed',
  device_token: '0b8d6f0e-2f0a-4c55-9d0c-3a1f6f1d7a11',
  pairing_code: '4821',
  display: display({}),
  dashboard: null,
  job_status: null,
  sync: { status: 'ok', delayed: false, delayed_since: null, last_success_at: 1 },
  server_time: 1,
  plant_timezone: 'UTC',
  admin_url: 'http://plant/admin',
  ...over,
});

/** Run the hook as a fresh render (no effects) to read what the TV would be showing now. */
function render() {
  runtime.idx = 0;
  runtime.mounting = false;
  return runHook();
}

function mount() {
  runtime.slots = [];
  runtime.idx = 0;
  runtime.effects = [];
  runtime.mounting = true;
  runHook();
  runtime.mounting = false;
  for (const effect of runtime.effects) effect();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    location: { search: '' },
    setInterval: (...a: Parameters<typeof setInterval>) => setInterval(...a),
    clearInterval: (...a: Parameters<typeof clearInterval>) => clearInterval(...a),
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (...a: Parameters<typeof clearTimeout>) => clearTimeout(...a),
  });
  ds.tvRegister.mockReset();
  ds.tvState.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const unknownToken = () => new DataSourceError(404, 'unknown device token');

describe('TV page when the server does not know its device token', () => {
  it('registers again after a failed first registration instead of polling a 404 forever', async () => {
    // Power-up with the API still starting: nginx answers 502 to the one-time register call, and
    // /state of a token that was never registered is 404.
    ds.tvRegister.mockRejectedValue(new DataSourceError(502, 'Bad Gateway'));
    ds.tvState.mockRejectedValue(unknownToken());
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(render().state).toBeNull();

    // The API is up a minute later; the TV keeps polling every 60 s for the next five minutes.
    ds.tvRegister.mockResolvedValue(tvState({}));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(render().state?.status, 'TV screen five minutes after the API came back').toBe('unclaimed');
  });

  it('shows a pairing code again after an admin deletes its display', async () => {
    const assigned = tvState({
      status: 'assigned',
      display: display({ name: 'Line 3', claimed_at: 1, job_number: 'J-100' }),
      job_status: 'ok',
    });
    ds.tvRegister.mockResolvedValue(assigned);
    ds.tvState.mockResolvedValue(assigned);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(render().state?.status).toBe('assigned');

    // Admin > Displays > Delete: the row and token are gone. A TV that registers now gets a new code.
    ds.tvState.mockRejectedValue(unknownToken());
    ds.tvRegister.mockResolvedValue(tvState({ pairing_code: '7302', display: display({ id: 8, pairing_code: '7302' }) }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(render().state?.status, 'TV screen five minutes after its display was deleted').toBe('unclaimed');
  });
});

describe('TV page when the server is unreachable or refuses the new registration', () => {
  const assigned = () =>
    tvState({ status: 'assigned', display: display({ name: 'Line 3', claimed_at: 1, job_number: 'J-100' }), job_status: 'ok' });

  it('keeps the last screen under the offline banner and does not register during an outage', async () => {
    ds.tvRegister.mockResolvedValue(assigned());
    ds.tvState.mockResolvedValue(assigned());
    mount();
    await vi.advanceTimersByTimeAsync(0);

    ds.tvState.mockRejectedValue(new DataSourceError(502, 'Bad Gateway'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const view = render();
    expect(view.state?.status).toBe('assigned');
    expect(view.offlineSince).not.toBeNull();
    expect(ds.tvRegister).toHaveBeenCalledTimes(1);
  });

  it('registers the same token again and keeps the last screen until that succeeds', async () => {
    ds.tvRegister.mockResolvedValue(assigned());
    ds.tvState.mockResolvedValue(assigned());
    mount();
    await vi.advanceTimersByTimeAsync(0);

    ds.tvState.mockRejectedValue(unknownToken());
    ds.tvRegister.mockRejectedValue(new DataSourceError(429, 'Too Many Requests'));
    await vi.advanceTimersByTimeAsync(60_000);

    const view = render();
    expect(view.state?.status).toBe('assigned');
    expect(view.offlineSince).not.toBeNull();
    expect(ds.tvRegister.mock.calls.length).toBeGreaterThan(1);
    expect(ds.tvRegister.mock.calls.every(([token]) => token === view.token)).toBe(true);

    ds.tvRegister.mockResolvedValue(tvState({ device_token: view.token }));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(render().state?.status).toBe('unclaimed');
    expect(render().offlineSince).toBeNull();
  });
});
