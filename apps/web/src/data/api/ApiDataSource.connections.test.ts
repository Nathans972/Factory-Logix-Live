/**
 * Browser connection budget for the live stream.
 *
 * The app is served over plain HTTP/1.1 (nginx `listen 80`, INSTALL.md: http://<host>:8080), so a
 * browser allows at most 6 connections per host, shared by every tab of the profile. MDN, EventSource:
 * "When not used over HTTP/2, SSE suffers from a limitation to the maximum number of open connections,
 * which can be especially painful when opening multiple tabs, as the limit is per browser and is set to
 * a very low number (6)." Every portal/admin tab (FreshnessPill in the top bar) and every TV tab holds
 * one EventSource for as long as it is open, so six tabs leave no connection for any request.
 *
 * `Browser` below is that 6-connection pool; the EventSource and fetch fakes draw from it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ApiDataSource } from './ApiDataSource';

const BROWSER_CONNECTIONS_PER_HOST = 6;

class Browser {
  free = BROWSER_CONNECTIONS_PER_HOST;
  private waiters: Array<() => void> = [];

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }
}

const globals = globalThis as Record<string, unknown>;
const saved = { EventSource: globals.EventSource, fetch: globals.fetch, document: globals.document };

function installBrowser(browser: Browser): void {
  // An EventSource keeps its connection until close().
  globals.EventSource = class FakeEventSource {
    onmessage: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private closed = false;
    private holding = false;
    constructor(readonly url: string) {
      void browser.acquire().then(() => {
        if (this.closed) browser.release();
        else this.holding = true;
      });
    }
    addEventListener(): void {}
    close(): void {
      this.closed = true;
      if (this.holding) {
        this.holding = false;
        browser.release();
      }
    }
  };
  // A request needs a connection while it runs.
  globals.fetch = async () => {
    await browser.acquire();
    try {
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{"ok":true}' };
    } finally {
      browser.release();
    }
  };
  // The six earlier tabs are in the background; the request below comes from the tab in front.
  globals.document = {
    hidden: true,
    visibilityState: 'hidden',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

afterEach(() => {
  globals.EventSource = saved.EventSource;
  globals.fetch = saved.fetch;
  globals.document = saved.document;
});

/** Open `tabs` tabs (one ApiDataSource + one subscriber each), then send a request from another tab. */
async function requestWithTabsOpen(tabs: number): Promise<string> {
  const browser = new Browser();
  installBrowser(browser);

  // Each tab has its own ApiDataSource and a subscriber, as FreshnessPill gives every portal tab.
  const unsubscribe: Array<() => void> = [];
  for (let tab = 0; tab < tabs; tab += 1) {
    unsubscribe.push(new ApiDataSource('/api').subscribe(() => undefined));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Another tab loads (or any tab calls the API): it needs a connection to nginx.
  const outcome = await Promise.race([
    new ApiDataSource('/api').health().then(() => 'served'),
    new Promise<string>((resolve) => setTimeout(() => resolve('still waiting for a connection'), 500)),
  ]);
  for (const stop of unsubscribe) stop();
  return outcome;
}

describe('live stream and the browser connection limit', () => {
  it('five open tabs still leave a connection free', async () => {
    expect(await requestWithTabsOpen(BROWSER_CONNECTIONS_PER_HOST - 1)).toBe('served');
  });

  it('six open tabs leave a connection free for a request from a seventh', async () => {
    expect(await requestWithTabsOpen(BROWSER_CONNECTIONS_PER_HOST)).toBe('served');
  });
});
