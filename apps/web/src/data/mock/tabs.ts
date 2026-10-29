/**
 * Keeps the demo's TVs the same in every browser tab (spec 12.5).
 *
 * Each tab simulates its own world (`MockStore`), but the demo bar, the Job page and the Help
 * menu open `/tv` in a new tab. So the displays, and which TV is bound to which display, are
 * mirrored over a BroadcastChannel: a job changed on /displays reaches a TV open in another tab,
 * and the code a TV shows can be claimed in Settings in another. Scans, shifts, standards and the
 * rest of the admin state stay per tab.
 *
 * Every change stamps the display (a Lamport clock, then the tab id) and is posted to the other
 * tabs, which keep the later stamp of each display, deletions included. So the tabs agree
 * whatever order the messages arrive in, and a TV registering in one tab never undoes a change
 * made in another. A tab that opens says hello and the others answer with every display changed
 * so far, so it starts from the same TVs.
 */
import type { MockStore, SharedDisplay } from './state';

/** Per base path, so two demos on one origin never mix. Rename it if the messages change. */
const CHANNEL = 'fld-demo-displays-v1:' + ((import.meta.env?.BASE_URL as string | undefined) ?? '/');

interface Stamp {
  clock: number;
  tab: string;
}

interface DisplayEntry extends SharedDisplay {
  id: number;
  stamp: Stamp;
}

type TabMessage =
  | { kind: 'hello' }
  | { kind: 'displays'; entries: DisplayEntry[]; next_display_id: number };

function later(a: Stamp, b: Stamp): boolean {
  return a.clock !== b.clock ? a.clock > b.clock : a.tab > b.tab;
}

function unref(t: unknown): void {
  const handle = t as { unref?: () => void };
  if (typeof handle?.unref === 'function') handle.unref();
}

/** Joins this tab's displays to the other tabs'. Does nothing where BroadcastChannel is missing. */
export function connectTabs(store: MockStore): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  // Node (tests): an open channel would keep the process alive.
  unref(channel);
  const tab = Math.random().toString(36).slice(2);
  /** the stamp of the last change to each display changed since the first tab opened */
  const stamps = new Map<number, Stamp>();
  const changed = new Set<number>();
  let clock = 0;

  const post = (ids: Iterable<number>): void => {
    const entries = [...ids].map((id) => ({ id, stamp: stamps.get(id)!, ...store.sharedDisplay(id) }));
    channel.postMessage({ kind: 'displays', entries, next_display_id: store.nextDisplayId } satisfies TabMessage);
  };

  store.onDisplayChanged = (id) => {
    // Posted once the change is complete: tvRegister binds the TV after announcing its display.
    if (changed.size === 0) {
      queueMicrotask(() => {
        clock += 1;
        for (const c of changed) stamps.set(c, { clock, tab });
        post(changed);
        changed.clear();
      });
    }
    changed.add(id);
  };

  channel.onmessage = (e: MessageEvent<TabMessage>) => {
    try {
      const msg = e.data;
      if (msg.kind === 'hello') {
        if (stamps.size > 0) post(stamps.keys());
        return;
      }
      const fresh: DisplayEntry[] = [];
      for (const entry of msg.entries) {
        clock = Math.max(clock, entry.stamp.clock);
        const mine = stamps.get(entry.id);
        if (mine !== undefined && !later(entry.stamp, mine)) continue;
        stamps.set(entry.id, entry.stamp);
        fresh.push(entry);
      }
      if (fresh.length > 0) store.adoptDisplays(fresh, msg.next_display_id);
    } catch (err) {
      // A bad message must never take the demo down.
      if (typeof console !== 'undefined') console.warn('[demo] tab sync failed', err);
    }
  };
  channel.postMessage({ kind: 'hello' } satisfies TabMessage);
}
