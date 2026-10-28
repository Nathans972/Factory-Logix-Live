import http, { type ServerResponse } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';
import { MAX_CLIENTS, serializeEvent, SseHub } from '../src/sse.js';

const log = pino({ level: 'silent' });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Enough of a ServerResponse for the hub to hold it as an open stream. */
const fakeStream = () => ({ writeHead: () => undefined, write: () => true, end: () => undefined }) as unknown as ServerResponse;

describe('SseHub with one client that reads and one that stopped', () => {
  it('closes the stalled one and keeps sending to the other', { timeout: 60_000 }, async () => {
    const hub = new SseHub('postgres://unused', log);
    const responses: ServerResponse[] = [];
    const server = http.createServer((_req, res) => {
      responses.push(res);
      hub.addClient(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const open = async (): Promise<net.Socket> => {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      const before = responses.length;
      socket.write('GET /api/events HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n');
      for (let i = 0; i < 200 && responses.length === before; i += 1) await sleep(10);
      return socket;
    };

    let received = 0;
    const reader = await open();
    reader.on('data', (chunk: Buffer) => (received += chunk.length));
    const stalled = await open();
    stalled.pause();
    const [readerRes, stalledRes] = responses;
    try {
      // The largest frame a NOTIFY (8000-byte payload) can turn into, a few per tick: about 16 MB.
      const hours = Array.from({ length: 570 }, (_, i) => 1_700_000_000_000 + i * 3_600_000);
      const frameBytes = Buffer.byteLength(serializeEvent({ type: 'data_updated', at: Date.now(), hours }));
      const frames = 2_000;
      for (let round = 0; round < frames / 4; round += 1) {
        for (let i = 0; i < 4; i += 1) hub.broadcast({ type: 'data_updated', at: Date.now(), hours });
        await tick();
      }
      for (let i = 0; i < 500 && received < frames * frameBytes; i += 1) await sleep(10);

      expect(stalledRes.destroyed, 'the stalled connection is closed, so nothing stays queued for it').toBe(true);
      expect(readerRes.destroyed, 'the reading client is still connected').toBe(false);
      expect(hub.clientCount).toBe(1);
      expect(received, 'the reading client got every frame').toBeGreaterThanOrEqual(frames * frameBytes);
    } finally {
      reader.destroy();
      stalled.destroy();
      await hub.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('/api/events when the hub is full', () => {
  it('ends a new stream with a retry hint, and takes one again once a stream closes', async () => {
    const sse = new SseHub('postgres://unused', log); // never started: no LISTEN connection needed
    const ctx = { env: { sessionSecret: 'a-very-long-test-session-secret-value' }, log, sse, version: 'test' };
    const app = await buildServer(ctx as unknown as AppContext);
    try {
      const ids = Array.from({ length: MAX_CLIENTS }, () => sse.addClient(fakeStream()));
      expect(ids).not.toContain(null);

      const refused = await app.inject({ method: 'GET', url: '/api/events' });
      expect(refused.statusCode).toBe(200);
      expect(refused.headers['content-type']).toBe('text/event-stream');
      // Ended at once: EventSource tries again in a minute instead of giving up as on an error status.
      expect(refused.payload).toBe('retry: 60000\n\n');
      expect(sse.clientCount).toBe(MAX_CLIENTS);

      sse.removeClient(ids[0] as number);
      const admitted = app.inject({ method: 'GET', url: '/api/events' });
      for (let i = 0; i < 200 && sse.clientCount < MAX_CLIENTS; i += 1) await sleep(5);
      expect(sse.clientCount).toBe(MAX_CLIENTS);
      await sse.stop(); // ends every stream, so the injected one resolves
      expect((await admitted).payload).toMatch(/^retry: 5000\n\nevent: heartbeat\n/);
    } finally {
      await sse.stop();
      await app.close();
    }
  });
});
