import type { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';

const created = vi.hoisted(() => ({ clients: [] as unknown[] }));

// ControlListener opens its own pg Client for LISTEN fld_control: swap in one that connects at once and lets the test emit notifications.
vi.mock('pg', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeClient extends Emitter {
    constructor() {
      super();
      created.clients.push(this);
    }
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: unknown[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    }
    async end(): Promise<void> {}
  }
  return { default: { Client: FakeClient } };
});

import { ControlListener } from '../src/control.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

async function startListener() {
  const listener = new ControlListener('postgres://unused', log);
  await listener.start();
  const client = created.clients[created.clients.length - 1] as EventEmitter;
  const send = (command: object) => client.emit('notification', { channel: 'fld_control', payload: JSON.stringify(command) });
  return { listener, send };
}

describe('control commands waiting for the collector loop', () => {
  it('one pending "recompute all standards" is enough however often it was requested while the collector was busy', async () => {
    const { listener, send } = await startListener();

    // The Admin > Standards button answers "Recompute started." at once and shows no busy state afterwards, so it gets pressed again.
    for (let i = 0; i < 5; i++) send({ cmd: 'recompute_standards' });

    // Each queued command is a full recompute of every (product, operation) over the standards lookback.
    expect(listener.take().filter((c) => c.cmd === 'recompute_standards')).toHaveLength(1);
  });
});
