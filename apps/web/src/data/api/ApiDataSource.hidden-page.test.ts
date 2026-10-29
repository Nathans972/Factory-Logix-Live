/**
 * A hidden page (background tab, minimized window) holds no event stream.
 *
 * Over plain HTTP/1.1 a browser allows six connections to the host across all its tabs, and an open
 * stream keeps one for good (ApiDataSource.connections.test.ts). So the data source closes the
 * stream while the page is hidden and opens a new one when it is shown, then sends `resync` so the
 * page refetches what it missed meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../DataSource';
import { ApiDataSource } from './ApiDataSource';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(): void {}

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** What the browser does when the response is not a 200 text/event-stream: fail for good. */
  failConnection(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.({ type: 'error' } as Event);
  }
}

/** Streams that still hold a connection. */
function openStreams(): FakeEventSource[] {
  return FakeEventSource.instances.filter((es) => es.readyState !== FakeEventSource.CLOSED);
}

/** The page's `document`, as far as visibility goes. */
const page = {
  hidden: false,
  listeners: new Set<() => void>(),
  get visibilityState(): string {
    return this.hidden ? 'hidden' : 'visible';
  },
  addEventListener(type: string, cb: () => void): void {
    if (type === 'visibilitychange') this.listeners.add(cb);
  },
  removeEventListener(type: string, cb: () => void): void {
    if (type === 'visibilitychange') this.listeners.delete(cb);
  },
};

/** The user switches tabs (or minimizes the window) and back. */
function setHidden(hidden: boolean): void {
  page.hidden = hidden;
  for (const cb of [...page.listeners]) cb();
}

describe('ApiDataSource event stream while the page is hidden', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    page.hidden = false;
    page.listeners.clear();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('document', page);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives the stream back while hidden, and opens a new one and sends resync when shown', () => {
    const ds = new ApiDataSource('/api');
    const seen: LiveEvent[] = [];
    ds.subscribe((e) => seen.push(e));
    expect(openStreams()).toHaveLength(1);

    // Already visible: nothing to do.
    setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    setHidden(true);
    expect(openStreams()).toHaveLength(0);
    setHidden(true);
    expect(seen).toEqual([]);

    setHidden(false);
    expect(openStreams()).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(seen.map((e) => e.type)).toEqual(['resync']);
  });

  it('opens no stream for a page that starts hidden until it is shown', () => {
    page.hidden = true;
    const ds = new ApiDataSource('/api');
    const seen: LiveEvent[] = [];
    ds.subscribe((e) => seen.push(e));
    ds.subscribe(() => undefined);
    expect(FakeEventSource.instances).toHaveLength(0);

    setHidden(false);
    expect(openStreams()).toHaveLength(1);
    expect(seen.map((e) => e.type)).toEqual(['resync']);
  });

  it('does not reopen a failed stream while the page is hidden', async () => {
    const ds = new ApiDataSource('/api');
    ds.subscribe(() => undefined);

    // nginx answers 502 while the api restarts, then the user switches to another tab.
    FakeEventSource.instances[0]!.failConnection();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    setHidden(false);
    expect(openStreams()).toHaveLength(1);
  });

  it('stops watching the page once nobody listens', () => {
    const ds = new ApiDataSource('/api');
    const stop = ds.subscribe(() => undefined);
    stop();
    expect(openStreams()).toHaveLength(0);
    expect(page.listeners.size).toBe(0);
  });
});
