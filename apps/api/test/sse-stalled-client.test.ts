import http, { type ServerResponse } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { SseHub } from '../src/sse.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SseHub with a client that stops reading', () => {
  it('does not keep queueing frames in server memory for it', { timeout: 60_000 }, async () => {
    const hub = new SseHub('postgres://unused', pino({ level: 'silent' }));

    // The same wiring as routes/events.ts: any request to the stream becomes a hub client.
    let serverSide: ServerResponse | null = null;
    const server = http.createServer((_req, res) => {
      serverSide = res;
      hub.addClient(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    // An anonymous client opens /api/events and then never reads another byte.
    const client = net.connect(port, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.write('GET /api/events HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n');
      client.pause();
      for (let i = 0; i < 200 && !serverSide; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(serverSide, 'the hub accepted the anonymous client').not.toBeNull();

      // Live traffic arriving over time (the loop yields so the kernel gets to flush what it can):
      // about 40 MB of frames, far more than the socket buffers on both ends can hold.
      const hours = Array.from({ length: 100 }, (_, i) => 1_700_000_000_000 + i * 3_600_000);
      for (let batch = 0; batch < 30; batch += 1) {
        for (let i = 0; i < 1_000; i += 1) hub.broadcast({ type: 'data_updated', at: Date.now(), hours });
        await tick();
      }

      const queuedBytes = (serverSide as unknown as ServerResponse).writableLength;
      // Either the stalled client is dropped, or what is queued for it stays small.
      expect(
        hub.clientCount === 0 || queuedBytes < 1_000_000,
        `stalled client still registered with ${(queuedBytes / 1e6).toFixed(1)} MB queued in server memory`,
      ).toBe(true);
    } finally {
      client.destroy();
      await hub.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
