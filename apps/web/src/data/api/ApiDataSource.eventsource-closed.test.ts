/**
 * Per the HTML Standard, an EventSource only reconnects by itself after a dropped connection.
 * When a reconnect attempt gets a non-200 response (nginx answers 502/503 while the api container
 * restarts) or a non-`text/event-stream` body, the browser "fails the connection": readyState
 * becomes CLOSED, an `error` event fires and it never tries again.
 *
 * `ApiDataSource` assumes "the browser reconnects on its own" and never looks at readyState, so
 * after one api restart every open TV and portal tab loses its event stream until a page reload
 * (nothing shows it; the 60 s polls keep the pages roughly fresh).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseEvent } from '@fld/shared';
import { ApiDataSource } from './ApiDataSource';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private listeners = new Map<string, Array<(ev: Event) => void>>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, cb: (ev: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The server sent a named event frame. */
  receive(name: string, payload: SseEvent): void {
    this.readyState = FakeEventSource.OPEN;
    for (const cb of this.listeners.get(name) ?? []) cb({ data: JSON.stringify(payload) } as unknown as Event);
  }

  /** What the browser does when the response is not a 200 text/event-stream: fail for good. */
  failConnection(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.({ type: 'error' } as Event);
  }

  /** What the browser does when an open stream drops: it reconnects by itself. */
  dropAndRetry(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.({ type: 'error' } as Event);
  }
}

describe('ApiDataSource event stream after the api restarts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens a new stream when the browser has closed the old one for good', async () => {
    const ds = new ApiDataSource('/api');
    const seen: SseEvent[] = [];
    ds.subscribe((e) => seen.push(e));
    expect(FakeEventSource.instances).toHaveLength(1);

    // The api restarts: the open stream drops, the browser retries after 5 s and nginx answers 502.
    FakeEventSource.instances[0]!.failConnection();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // A live stream must exist again, otherwise data_updated / display_updated never arrive.
    const open = FakeEventSource.instances.filter((es) => es.readyState !== FakeEventSource.CLOSED);
    expect(open).toHaveLength(1);
    open[0]!.receive('display_updated', { type: 'display_updated', at: Date.now(), display_id: 1 });
    expect(seen.some((e) => e.type === 'display_updated')).toBe(true);
  });

  it('leaves a stream alone that the browser is reconnecting by itself', async () => {
    const ds = new ApiDataSource('/api');
    ds.subscribe(() => undefined);
    FakeEventSource.instances[0]!.dropAndRetry();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
