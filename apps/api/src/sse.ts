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
      const id = Number(data.display_id ?? data.id);
      return {
        type: 'display_updated',
        at: now,
        display_id: Number.isFinite(id) ? id : 0,
        device_token: typeof data.device_token === 'string' ? data.device_token : undefined,
      };
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

  addClient(res: ServerResponse): number {
    const id = this.nextId++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
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
