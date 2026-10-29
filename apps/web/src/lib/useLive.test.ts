/**
 * `useLiveRefetch` and `resync`: a page shown again after its stream was closed while hidden
 * refetches what its events would have refreshed, unless it listens to no events at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../data/DataSource';

// The web tests have no DOM library: the hook is called outside a component and its effect runs at once.
vi.mock('react', () => ({
  useRef: (init: unknown) => ({ current: init }),
  useEffect: (fn: () => void) => {
    fn();
  },
}));
const ds = vi.hoisted(() => {
  const listeners: Array<(e: LiveEvent) => void> = [];
  return {
    listeners,
    subscribe: (cb: (e: LiveEvent) => void) => {
      listeners.push(cb);
      return () => undefined;
    },
  };
});
const invalidateQueries = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries }) }));
vi.mock('../data/DataSourceContext', () => ({ useDataSource: () => ds }));

const { useLiveRefetch } = await import('./useLive');

function emit(e: LiveEvent): void {
  for (const listener of ds.listeners) listener(e);
}

beforeEach(() => {
  ds.listeners.length = 0;
  invalidateQueries.mockReset();
});

describe('useLiveRefetch and resync', () => {
  it('refetches on resync as on one of its own events', () => {
    useLiveRefetch(['sync_health'], [['syncHealth']]);
    emit({ type: 'data_updated', at: 1, hours: [] });
    expect(invalidateQueries).not.toHaveBeenCalled();

    emit({ type: 'resync', at: 1 });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['syncHealth'] });
  });

  it('ignores resync when it listens to no events', () => {
    // The Shift and Home pages listen to nothing once the shift has ended.
    useLiveRefetch([]);
    emit({ type: 'resync', at: 1 });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
