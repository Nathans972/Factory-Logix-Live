/**
 * Collector control channel (docs/API.md): a dedicated Postgres connection LISTENs on
 * `fld_control`. Commands are queued and drained by the main loop.
 */
import pgPkg from 'pg';
import type { Client } from 'pg';
import type { Logger } from './logger.js';

const { Client: PgClient } = pgPkg;

export type ControlCommand =
  | { cmd: 'restart' }
  | { cmd: 'backfill_now' }
  | { cmd: 'recompute_standards'; product_number?: string | null }
  | { cmd: 'recompute_cells'; from_utc: number; to_utc: number };

export function parseControlPayload(payload: string | undefined): ControlCommand | null {
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const cmd = (parsed as { cmd?: unknown }).cmd;
  switch (cmd) {
    case 'restart':
      return { cmd: 'restart' };
    case 'backfill_now':
      return { cmd: 'backfill_now' };
    case 'recompute_standards': {
      const product = (parsed as { product_number?: unknown }).product_number;
      return { cmd: 'recompute_standards', product_number: typeof product === 'string' && product ? product : null };
    }
    case 'recompute_cells': {
      const from = Number((parsed as { from_utc?: unknown }).from_utc);
      const to = Number((parsed as { to_utc?: unknown }).to_utc);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
      return { cmd: 'recompute_cells', from_utc: from, to_utc: to };
    }
    default:
      return null;
  }
}

export class ControlListener {
  private client: Client | null = null;
  private queue: ControlCommand[] = [];
  /** What `take()` handed over last: the main loop runs it in this order. */
  private taken: ControlCommand[] = [];
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Called when a command arrives so the main loop can wake up early. */
  onCommand: (() => void) | null = null;
  /** The command the main loop is running, set by it around each one `take()` handed over. */
  running: ControlCommand | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.stopping) return;
    try {
      const client = new PgClient({ connectionString: this.connectionString, application_name: 'fld-collector-control' });
      client.on('notification', (msg) => {
        const command = parseControlPayload(msg.payload);
        if (!command) {
          this.log.warn({ payload: msg.payload }, 'ignored malformed control command');
          return;
        }
        if (this.alreadyRequested(command)) {
          this.log.info({ command }, 'control command ignored: the same one is already waiting or running');
          return;
        }
        this.log.info({ command }, 'control command received');
        this.queue.push(command);
        this.onCommand?.();
      });
      client.on('error', (err) => {
        this.log.warn({ err: err.message }, 'control channel error; reconnecting');
        this.scheduleReconnect();
      });
      await client.connect();
      await client.query('LISTEN fld_control');
      this.client = client;
      this.log.info('listening on fld_control');
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'could not open the control channel; retrying');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const old = this.client;
    this.client = null;
    if (old) void old.end().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, 5_000);
    this.reconnectTimer.unref?.();
  }

  /**
   * Whether a command still to run already does what `command` asks, so a request made again (the
   * Recompute buttons show nothing while a run is going) does not queue the same work twice: an
   * identical command with nothing after it that may change what it computes. A restart may, for
   * any command (new settings, shifts and breaks), and so may a standards recompute for an hour cell
   * recompute (new StdHr); the new request may have been made to see that. A standards recompute,
   * many minutes without a poll in a large plant, is also covered by the identical one running: no
   * poll goes out meanwhile, and what else it reads changes only with a restart, which would be
   * waiting after it.
   */
  private alreadyRequested(command: ControlCommand): boolean {
    const running = this.running;
    const toRun = [
      ...(running?.cmd === 'recompute_standards' ? [running] : []),
      ...(running ? this.taken.slice(this.taken.indexOf(running) + 1) : []),
      ...this.queue,
    ];
    const key = JSON.stringify(command);
    for (const later of toRun.reverse()) {
      if (JSON.stringify(later) === key) return true;
      if (later.cmd === 'restart' || (later.cmd === 'recompute_standards' && command.cmd === 'recompute_cells')) return false;
    }
    return false;
  }

  /** Drain the queued commands. */
  take(): ControlCommand[] {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    this.taken = out;
    return out;
  }

  get pending(): number {
    return this.queue.length;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }
}
