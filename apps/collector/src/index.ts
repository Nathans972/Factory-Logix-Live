/**
 * Collector service entry point (spec 3.1, 4.x).
 *
 * One async loop: poll FactoryLogix -> ingest -> recompute hour cells -> notify, plus the
 * nightly standards job and the historical backfill. Nothing in here is allowed to kill the
 * process: every iteration is wrapped, errors are logged and the loop continues.
 */
import { hourStartUtc, nextLocalTime } from '@fld/engine';
import type { MappingConfig, Settings } from '@fld/shared';
import { ControlListener, type ControlCommand } from './control.js';
import { createPool, exec, type Pool } from './db.js';
import { Recomputer } from './engine/recompute.js';
import { HOUR_MS } from './engine/hours.js';
import { StandardsRecomputer } from './engine/standards.js';
import { HealthReporter } from './health.js';
import { Ingestor } from './ingest/datasets.js';
import { OperationCache } from './ingest/operations.js';
import { loadEnv, type Env } from './env.js';
import { createLogger, errorMessage, type Logger } from './logger.js';
import { TimestampResolver } from './mapping/extract.js';
import { loadConfig, type CollectorConfig } from './settings.js';
import { ODataSource } from './sources/ODataSource.js';
import { Backfill } from './sync/backfill.js';
import { CircuitBreaker } from './sync/breaker.js';
import { Poller, type PollOutcome } from './sync/poller.js';

const IDLE_WHEN_UNCONFIGURED_MS = 30_000;
const HEARTBEAT_SLICE_MS = 30_000;
const CONFIG_RELOAD_EVERY_POLLS = 10;

class Collector {
  private readonly log: Logger;
  private readonly pool: Pool;
  private readonly health: HealthReporter;
  private readonly operations: OperationCache;
  private readonly timestamps: TimestampResolver;
  private readonly recomputer: Recomputer;
  private readonly standards: StandardsRecomputer;
  private readonly control: ControlListener;
  private readonly breaker = new CircuitBreaker();

  private config: CollectorConfig | null = null;
  private source: ODataSource | null = null;
  private poller: Poller | null = null;
  private ingestor: Ingestor | null = null;
  private backfill: Backfill | null = null;

  private connectionFingerprint = '';
  private mappingFingerprint = '';
  private pollCount = 0;
  private reloadRequested = true;
  private nextStandardsAt: number | null = null;
  private lastRetentionRunAt = 0;
  private stopping = false;
  private wake: (() => void) | null = null;
  private warnedUnconfigured = false;

  constructor(private readonly env: Env) {
    this.log = createLogger({ level: env.logLevel, pretty: !env.isProduction });
    this.pool = createPool(env.databaseUrl, this.log);
    this.health = new HealthReporter(this.pool, this.log);
    this.operations = new OperationCache(this.pool);
    this.timestamps = new TimestampResolver({
      mode: 'offset_present',
      timezone: env.plantTimezone,
      onWarn: (code, message) => this.log.warn({ code }, message),
    });
    this.recomputer = new Recomputer(this.pool, this.log, this.operations);
    this.standards = new StandardsRecomputer(this.pool, this.log, this.operations);
    this.control = new ControlListener(env.databaseUrl, this.log);
    this.control.onCommand = () => this.wake?.();
  }

  get settings(): Settings | null {
    return this.config?.settings ?? null;
  }

  private get configured(): boolean {
    return Boolean(this.config?.mapping && this.config.connection && this.poller);
  }

  async start(): Promise<void> {
    this.log.info({ node: process.version }, 'collector starting');
    // The database may still be starting up: never fail startup, the loop retries.
    try {
      await this.health.ensureRow();
      // Resume the breaker state so a restart does not report "never" while data exists.
      const state = await this.health.load();
      if (state) {
        this.breaker.hydrate({
          consecutiveFailures: state.consecutive_failures,
          lastSuccessAt: state.last_success_at,
          lastError: state.last_error,
          openUntil: state.breaker_open_until,
        });
      }
      await this.operations.preload();
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, 'database not ready at startup; retrying');
    }
    await this.control.start();
    await this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.iterate();
      } catch (err) {
        this.log.error({ err: errorMessage(err) }, 'collector iteration failed');
        await this.delay(5_000);
      }
    }
  }

  private async iterate(): Promise<void> {
    await this.handleCommands();

    if (this.reloadRequested || this.pollCount % CONFIG_RELOAD_EVERY_POLLS === 0) {
      await this.reloadConfig();
    }

    const settings = this.config?.settings;
    if (!settings) {
      await this.delay(IDLE_WHEN_UNCONFIGURED_MS);
      return;
    }
    const intervalMs = settings.poll_interval_seconds * 1_000;
    const breakerOpts = {
      threshold: settings.breaker_failure_threshold,
      maxBackoffMinutes: settings.breaker_max_backoff_minutes,
      intervalMs,
    };

    if (!this.configured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.log.warn(
          {
            mapping: Boolean(this.config?.mapping),
            connection: Boolean(this.config?.connection),
            mapping_error: this.config?.mapping_error,
            connection_error: this.config?.connection_error,
          },
          'waiting for the first-run wizard: FactoryLogix connection and field mapping are required',
        );
      }
      await this.health.report({
        snapshot: this.breaker.snapshot(),
        now: Date.now(),
        intervalMs,
        threshold: settings.breaker_failure_threshold,
        configured: false,
        force: true,
      });
      await this.delay(IDLE_WHEN_UNCONFIGURED_MS);
      this.reloadRequested = true;
      return;
    }
    this.warnedUnconfigured = false;

    const mapping = this.config?.mapping as MappingConfig;
    const now = Date.now();
    await this.source?.init();

    let outcome: PollOutcome;
    try {
      outcome = await (this.poller as Poller).pollOnce(mapping, settings, now);
    } catch (err) {
      outcome = { ok: false, rows: 0, touched: [], error: errorMessage(err), datasets: [], durationMs: Date.now() - now };
    }
    this.pollCount += 1;

    if (outcome.ok) {
      this.breaker.recordSuccess(Date.now());
      this.log.info({ rows: outcome.rows, ms: outcome.durationMs }, 'poll ok');
      // A recompute failure must not stop ingestion: the next poll recomputes the same hours.
      try {
        await this.recomputeTouched(outcome.touched, settings);
      } catch (err) {
        this.log.error({ err: errorMessage(err) }, 'hour cell recompute failed');
      }
    } else {
      this.breaker.recordFailure(Date.now(), outcome.error ?? 'poll failed', breakerOpts);
      this.log.warn({ err: outcome.error, failures: this.breaker.consecutiveFailures }, 'poll failed');
    }

    await this.health.report({
      snapshot: this.breaker.snapshot(),
      now: Date.now(),
      intervalMs,
      threshold: settings.breaker_failure_threshold,
      configured: true,
      force: true,
    });

    try {
      await this.maybeRecomputeStandards(settings, mapping);
    } catch (err) {
      this.log.error({ err: errorMessage(err) }, 'standards recompute failed');
    }
    await this.maybeTrimRawEvents(settings);

    const delay = this.breaker.nextDelayMs(breakerOpts);
    await this.idle(Date.now() + delay, settings, mapping, intervalMs);
  }

  /** Touched instants -> hour buckets (+ current and previous hour) -> recompute + NOTIFY. */
  private async recomputeTouched(touched: number[], settings: Settings): Promise<void> {
    const tz = settings.plant_timezone;
    const hours = new Set<number>();
    const now = Date.now();
    const currentHour = hourStartUtc(now, tz);
    hours.add(currentHour);
    hours.add(currentHour - HOUR_MS);
    for (const instant of touched) {
      if (Number.isFinite(instant)) hours.add(hourStartUtc(instant, tz));
    }
    await this.recomputer.recomputeHours(hours, settings, now);
  }

  private async reloadConfig(): Promise<void> {
    const config = await loadConfig(this.pool, {
      encryptionKey: this.env.encryptionKey,
      fallbackTimezone: this.env.plantTimezone,
      log: this.log,
    });
    this.reloadRequested = false;
    this.config = config;
    this.timestamps.configure(config.settings.fl_timestamp_mode, config.settings.plant_timezone);
    if (config.mapping_error) this.log.warn({ err: config.mapping_error }, 'stored mapping is invalid');
    if (config.connection_error) this.log.warn({ err: config.connection_error }, 'stored FactoryLogix connection is unusable');

    if (!config.mapping || !config.connection) {
      this.source = null;
      this.poller = null;
      this.ingestor = null;
      this.backfill = null;
      this.connectionFingerprint = '';
      this.mappingFingerprint = '';
      return;
    }

    const connectionFingerprint = JSON.stringify([config.connection.base_url, config.connection.username, config.connection.password]);
    const mappingFingerprint = JSON.stringify(config.mapping);

    if (!this.source || connectionFingerprint !== this.connectionFingerprint) {
      this.source = new ODataSource({
        baseUrl: config.connection.base_url,
        username: config.connection.username,
        password: config.connection.password,
        timeoutSeconds: config.settings.odata_timeout_seconds,
        onMetadataError: (err) => this.log.warn({ err: errorMessage(err) }, 'could not read $metadata; assuming OData v4 literals'),
      });
      this.connectionFingerprint = connectionFingerprint;
      await this.source.init(true);
    } else {
      this.source.setTimeoutSeconds(config.settings.odata_timeout_seconds);
    }

    if (!this.ingestor) {
      this.ingestor = new Ingestor(
        { pool: this.pool, log: this.log, operations: this.operations, timestamps: this.timestamps },
        config.mapping,
      );
    } else if (mappingFingerprint !== this.mappingFingerprint) {
      this.ingestor.setMapping(config.mapping);
    }
    this.mappingFingerprint = mappingFingerprint;

    if (!this.poller) {
      this.poller = new Poller({ pool: this.pool, log: this.log, ingestor: this.ingestor, timestamps: this.timestamps }, this.source);
    } else {
      this.poller.setSource(this.source);
    }

    if (!this.backfill) {
      this.backfill = new Backfill(this.pool, this.log, this.poller, this.recomputer, async (settings, mapping, now) => {
        const result = await this.standards.run({ settings, mapping, now, productNumber: null, since: null });
        await this.health.setLastStandardsRecompute(Date.now());
        this.log.info(result, 'standards recomputed after backfill');
      });
    }
    await this.backfill.ensureScheduled(config.settings);

    if (this.nextStandardsAt === null) {
      try {
        const state = await this.health.load();
        this.nextStandardsAt = nextLocalTime(config.settings.plant_timezone, config.settings.std_recompute_time, Date.now());
        this.log.info(
          { next_standards_at: new Date(this.nextStandardsAt).toISOString(), last: state?.last_standards_recompute_at },
          'standards schedule set',
        );
      } catch (err) {
        this.log.warn({ err: errorMessage(err) }, 'could not schedule the nightly standards recompute');
      }
    }
  }

  private async handleCommands(): Promise<void> {
    const commands = this.control.take();
    for (const command of commands) {
      try {
        await this.runCommand(command);
      } catch (err) {
        this.log.error({ err: errorMessage(err), command }, 'control command failed');
      }
    }
  }

  private async runCommand(command: ControlCommand): Promise<void> {
    const settings = this.config?.settings;
    switch (command.cmd) {
      case 'restart':
        this.log.info('reloading settings, mapping and connection');
        this.source = null;
        this.connectionFingerprint = '';
        this.operations.clear();
        this.nextStandardsAt = null;
        this.reloadRequested = true;
        await this.reloadConfig();
        return;
      case 'backfill_now':
        await this.backfill?.requestNow();
        return;
      case 'recompute_standards': {
        if (!settings) return;
        const result = await this.standards.run({
          settings,
          mapping: this.config?.mapping ?? null,
          now: Date.now(),
          productNumber: command.product_number ?? null,
          since: null,
        });
        await this.health.setLastStandardsRecompute(Date.now());
        await this.recomputer.recomputeCurrentHours(settings, Date.now());
        this.log.info({ ...result, product: command.product_number ?? 'all' }, 'on-demand standards recompute finished');
        return;
      }
      case 'recompute_cells': {
        if (!settings) return;
        const tz = settings.plant_timezone;
        const hours: number[] = [];
        let hour = hourStartUtc(command.from_utc, tz);
        const guard = 24 * 400;
        while (hour < command.to_utc && hours.length < guard) {
          hours.push(hour);
          hour += HOUR_MS;
        }
        await this.recomputer.recomputeHours(hours, settings, Date.now());
        this.log.info({ hours: hours.length }, 'on-demand cell recompute finished');
        return;
      }
      default:
        return;
    }
  }

  /** Nightly standards recompute at `std_recompute_time` plant time (spec 7.1). */
  private async maybeRecomputeStandards(settings: Settings, mapping: MappingConfig): Promise<void> {
    const now = Date.now();
    if (this.nextStandardsAt === null || now < this.nextStandardsAt) return;
    const state = await this.health.load();
    const result = await this.standards.run({
      settings,
      mapping,
      now,
      productNumber: null,
      since: state?.last_standards_recompute_at ?? null,
    });
    await this.health.setLastStandardsRecompute(now);
    await this.recomputer.recomputeCurrentHours(settings, Date.now());
    this.nextStandardsAt = nextLocalTime(settings.plant_timezone, settings.std_recompute_time, Date.now());
    this.log.info({ ...result, next: new Date(this.nextStandardsAt).toISOString() }, 'nightly standards recompute finished');
  }

  /** retention_days_raw_events (spec 6.4): keep raw payloads only for as long as configured. */
  private async maybeTrimRawEvents(settings: Settings): Promise<void> {
    const days = settings.retention_days_raw_events;
    if (!days || days < 1) return;
    const now = Date.now();
    if (now - this.lastRetentionRunAt < 24 * 3_600_000) return;
    this.lastRetentionRunAt = now;
    try {
      // TimescaleDB: dropping whole chunks is far cheaper than DELETE (and works on compressed ones).
      await exec(this.pool, `SELECT drop_chunks('raw_events', older_than => ($1 || ' days')::interval)`, [days]);
    } catch {
      try {
        const removed = await exec(this.pool, `DELETE FROM raw_events WHERE received_at < now() - ($1 || ' days')::interval`, [days]);
        this.log.info({ days, removed }, 'raw_events retention applied');
      } catch (err) {
        this.log.warn({ err: errorMessage(err) }, 'raw_events retention failed');
      }
    }
  }

  /**
   * Wait until the next poll while keeping the heartbeat alive and using the idle time for
   * backfill chunks (spec 4.7).
   */
  private async idle(until: number, settings: Settings, mapping: MappingConfig, intervalMs: number): Promise<void> {
    while (!this.stopping && Date.now() < until) {
      const now = Date.now();
      await this.health.report({
        snapshot: this.breaker.snapshot(),
        now,
        intervalMs,
        threshold: settings.breaker_failure_threshold,
        configured: this.configured,
      });

      if (this.backfill) {
        await this.backfill.load();
        if (this.backfill.isActive()) {
          if (this.backfill.shouldRun(settings, now) && until - now > 5_000) {
            // One chunk per pass: a downloaded day, the standards recompute, or a re-colored day.
            await this.backfill.tick(mapping, settings, Date.now()).catch((err) => {
              this.log.error({ err: errorMessage(err) }, 'backfill chunk failed');
            });
            await this.delay(Math.min(settings.backfill_pause_seconds * 1_000, Math.max(0, until - Date.now())));
            continue;
          }
          await this.backfill.pause();
        }
      }

      const slice = Math.min(HEARTBEAT_SLICE_MS, until - Date.now());
      if (slice > 0) await this.delay(slice);
      if (this.control.pending > 0) return;
    }
  }

  /** Sleep, but wake up immediately when a control command arrives or we are shutting down. */
  private delay(ms: number): Promise<void> {
    if (ms <= 0 || this.stopping) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info('collector shutting down');
    this.wake?.();
    await this.control.stop().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
  }
}

async function bootstrap(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error(`collector cannot start: ${errorMessage(err)}`);
    process.exit(1);
    return;
  }

  const collector = new Collector(env);
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void collector
      .stop()
      .catch(() => undefined)
      .finally(() => {
        process.exitCode = 0;
        setTimeout(() => process.exit(0), 2_000).unref();
      });
    void signal;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection in collector', reason);
  });

  await collector.start().catch((err) => {
    console.error(`collector stopped unexpectedly: ${errorMessage(err)}`);
    process.exit(1);
  });
}

void bootstrap();
