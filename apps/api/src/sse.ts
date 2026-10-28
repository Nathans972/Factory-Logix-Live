/**
 * Server-sent events fan-out.
 *
 * A dedicated pg client LISTENs on the collector's channels and re-broadcasts to every connected
 * browser as `SseEvent`s (event name = `type`). A heartbeat is sent every 25 s.
 */
import type { ServerResponse } from 'node:http';
import pg from 'pg';
import type { Client as PgClient, Notification } from 'pg';
import type { SseEvent, SyncStatus, UtcMs } from '@fld/shared';
import type { Logger } from './logger.js';

const { Client } = pg;

export const CHANNELS = ['fld_data_updated', 'fld_sync_health', 'fld_display_updated'] as const;
const HEARTBEAT_MS = 25_000;
/**
 * Bytes a client may have waiting in this process before it is dropped. A client that reads stays far
 * below it: frames are small and seconds apart, and Node holds what it writes only until the next tick
 * (16 of the largest frames, 8 KB each, fit in one). One that stops reading (hung, asleep, or on
 * purpose: the stream needs no login) would otherwise have every later frame kept for it in memory.
 */
const MAX_QUEUED_BYTES = 128 * 1024;
/**
 * Streams served at once (exported for tests). Far more than a plant has TVs and portal tabs, and with
 * MAX_QUEUED_BYTES a bound on what stalled streams can hold.
 */
export const MAX_CLIENTS = 1000;
/** How long a browser turned away by a full hub waits before trying again. */
const FULL_RETRY_MS = 60_000;

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

interface SseClient {
  id: number;
  res: ServerResponse;
}

function toUtcMs(value: unknown): UtcMs | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  return null;
}

/** Translate a Postgres NOTIFY into an SseEvent (exported for tests). */
export function notificationToEvent(channel: string, payload: string | undefined, now: UtcMs): SseEvent | null {
  let data: Record<string, unknown> = {};
  if (payload) {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  switch (channel) {
    case 'fld_data_updated': {
      const raw = Array.isArray(data.hours) ? (data.hours as unknown[]) : [];
      const hours = raw.map(toUtcMs).filter((h): h is UtcMs => h !== null);
      return { type: 'data_updated', at: now, hours };
    }
    case 'fld_sync_health':
      return {
        type: 'sync_health',
        at: now,
        status: (data.status as SyncStatus) ?? 'never',
        delayed: Boolean(data.delayed),
      };
    case 'fld_display_updated': {
      // Only the id: a device_token in the payload must not reach the unauthenticated stream.
      const id = Number(data.display_id ?? data.id);
      return { type: 'display_updated', at: now, display_id: Number.isFinite(id) ? id : 0 };
    }
    default:
      return null;
  }
}

export function serializeEvent(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseHub {
  private clients = new Map<number, SseClient>();
  private nextId = 1;
  private client: PgClient | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastFullWarningAt = 0;

  constructor(
    private readonly connectionString: string,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectListener();
    this.heartbeat = setInterval(() => {
      this.broadcast({ type: 'heartbeat', at: Date.now() });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.connectionString, application_name: 'fld-api-listen' });
    client.on('error', (err: Error) => {
      this.log.warn({ err }, 'LISTEN connection error; reconnecting');
      this.scheduleReconnect();
    });
    client.on('end', () => {
      if (!this.stopped) this.scheduleReconnect();
    });
    client.on('notification', (msg: Notification) => {
      const event = notificationToEvent(msg.channel, msg.payload, Date.now());
      if (event) this.broadcast(event);
    });
    try {
      await client.connect();
      for (const channel of CHANNELS) await client.query(`LISTEN ${channel}`);
      this.client = client;
      this.log.info({ channels: CHANNELS }, 'listening for collector notifications');
    } catch (err) {
      this.log.warn({ err }, 'could not start LISTEN connection; retrying');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const old = this.client;
    this.client = null;
    if (old) {
      old.removeAllListeners();
      old.end().catch(() => undefined);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener();
    }, 5_000);
    this.reconnectTimer.unref?.();
  }

  /** Starts the stream on `res` and returns its id, or answers and closes `res` and returns null when full. */
  addClient(res: ServerResponse): number | null {
    if (this.clients.size >= MAX_CLIENTS) {
      const now = Date.now();
      if (now - this.lastFullWarningAt >= 60_000) {
        this.lastFullWarningAt = now;
        this.log.warn({ clients: this.clients.size }, 'SSE stream limit reached; turning new streams away');
      }
      // A stream that ends at once, so EventSource tries again after `retry`. An error status would
      // make it give up for good, leaving a TV on its 60 s poll until the page is reloaded.
      res.writeHead(200, STREAM_HEADERS);
      res.end(`retry: ${FULL_RETRY_MS}\n\n`);
      return null;
    }
    const id = this.nextId++;
    res.writeHead(200, STREAM_HEADERS);
    res.write(`retry: 5000\n\n`);
    res.write(serializeEvent({ type: 'heartbeat', at: Date.now() }));
    this.clients.set(id, { id, res });
    return id;
  }

  removeClient(id: number): void {
    this.clients.delete(id);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(event: SseEvent): void {
    if (this.clients.size === 0) return;
    const frame = serializeEvent(event);
    for (const [id, client] of this.clients) {
      try {
        if (client.res.writableEnded || client.res.destroyed) {
          this.clients.delete(id);
          continue;
        }
        client.res.write(frame);
        if (client.res.writableLength > MAX_QUEUED_BYTES) {
          // It has stopped reading. Free what Node holds for it; a real EventSource reconnects.
          this.log.debug({ queued: client.res.writableLength }, 'dropping SSE client that stopped reading');
          this.clients.delete(id);
          client.res.destroy();
        }
      } catch (err) {
        this.log.debug({ err }, 'dropping SSE client');
        this.clients.delete(id);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
    for (const [, client] of this.clients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.client) {
      this.client.removeAllListeners();
      await this.client.end().catch(() => undefined);
      this.client = null;
    }
  }
}
