/**
 * Collector service entry point (spec 3.1, 4.x).
 *
 * One async loop: poll FactoryLogix -> ingest -> recompute hour cells -> notify, plus the
 * nightly standards job and the historical backfill. Nothing in here is allowed to kill the
 * process: every iteration is wrapped, errors are logged and the loop continues.
 */
import { readFileSync } from 'node:fs';
import { hourStartUtc, nextLocalTime, utcToLocalParts } from '@fld/engine';
import { checkExtraCaFile, type MappingConfig, type Settings } from '@fld/shared';
import { ControlListener, type ControlCommand } from './control.js';
import { createPool, exec, type Pool } from './db.js';
import { Recomputer } from './engine/recompute.js';
import { HOUR_MS, hoursInRange, mergeHourRanges } from './engine/hours.js';
import { StandardsRecomputer, type StandardsRunResult } from './engine/standards.js';
import { HealthReporter } from './health.js';
import { Ingestor } from './ingest/datasets.js';
import { OperationCache } from './ingest/operations.js';
import { loadEnv, type Env } from './env.js';
import { createLogger, errorMessage, type Logger } from './logger.js';
import { TimestampResolver } from './mapping/extract.js';
import { ODataError } from './odata/client.js';
import { connectionSavedAt, loadConfig, loginRefusedMessage, type CollectorConfig } from './settings.js';
import { ODataSource } from './sources/ODataSource.js';
import { Backfill } from './sync/backfill.js';
import { CircuitBreaker, type BreakerSnapshot } from './sync/breaker.js';
import { Poller, type PollOutcome } from './sync/poller.js';
import { loadSyncState, recordSyncFailure, recordSyncSuccess } from './sync/state.js';

const IDLE_WHEN_UNCONFIGURED_MS = 30_000;
const HEARTBEAT_SLICE_MS = 30_000;
const CONFIG_RELOAD_EVERY_POLLS = 10;
/** sync_state row of the standards recomputes of every product: nightly, "Recompute all standards now", after a backfill. */
const STANDARDS_SOURCE = 'standards_recompute';
/** The start of what a failed nightly standards recompute adds to `last_error` (see `healthSnapshot`). */
const STANDARDS_ERROR = 'could not recompute the standards';
const STANDARDS_RETRY_MS = 10 * 60_000;
const STANDARDS_RETRY_MAX_MS = 2 * 3_600_000;

/** One `last_error` for a pass that went wrong more than one way, in the order it did. */
function joinErrors(...errors: (string | null)[]): string {
  return errors.filter(Boolean).join('; ');
}

/**
 * Why the saved connection or mapping cannot be used, from what `loadConfig` reports, for Sync
 * health while the collector waits. Null when nothing is saved yet, or everything saved is usable.
 */
function configError(config: CollectorConfig | null): string | null {
  const mapping = config?.mapping_error ? `the saved field mapping is invalid, fix it in Admin > Mapping: ${config.mapping_error}` : null;
  return joinErrors(config?.connection_error ?? null, mapping) || null;
}

/** A failed nightly standards recompute is tried again after 10 minutes, then 20, 40 ... at most every 2 hours. */
function standardsRetryMs(failures: number): number {
  return Math.min(STANDARDS_RETRY_MS * 2 ** Math.min(failures - 1, 10), STANDARDS_RETRY_MAX_MS);
}

/** HH:MM in `tz`. */
function clockTime(utcMs: number, tz: string): string {
  const { hour, minute } = utcToLocalParts(utcMs, tz);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

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
  /**
   * The login FactoryLogix refused (`PollOutcome.loginRefused`), as `connectionFingerprint`, and
   * when Admin > Connection had last been saved then. Nothing goes out with that login any more,
   * not even $metadata, until the connection is saved again: another login, or the same one once
   * the account works again. Retrying on the breaker schedule, or after every settings edit, would
   * only add failed logins towards an account lockout. In memory: a restarted collector tries once.
   */
  private refusedLogin: { connection: string; savedAt: number | null } | null = null;
  /**
   * Hours whose cells could not be recomputed, tried again with every poll until they are (see
   * `recomputeTouched`): the watermarks have moved past their rows, so no later poll touches them.
   * In memory only: after a restart they wait for the late-data re-pull (`late_data_hours`).
   */
  private readonly staleHours = new Set<number>();
  private mappingFingerprint = '';
  private pollCount = 0;
  private reloadRequested = true;
  private nextStandardsAt: number | null = null;
  /**
   * The nightly standards recompute failed, and no recompute of every product has gone through
   * since: StdHr is going stale. Admin > Sync shows it (`healthSnapshot`, the `standards_recompute`
   * row), and it is tried again at `retryAt` (`standardsRetryMs`), or tonight if that is sooner.
   * Read back from that row after a restart.
   */
  private standardsFailure: { error: string; failures: number; retryAt: number } | null = null;
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
    // FACTORYLOGIX_CA_CERT: Node skips a CA file it cannot use without saying so.
    const ca = checkExtraCaFile(process.env.NODE_EXTRA_CA_CERTS, (path) => readFileSync(path, 'latin1'));
    if (ca?.ok) this.log.info(ca.message);
    else if (ca) this.log.error(ca.message);
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
      // A nightly standards recompute that was failing before the restart still is, until one goes through.
      const standards = await loadSyncState(this.pool, STANDARDS_SOURCE);
      if (standards && standards.consecutive_failures > 0) {
        const failures = standards.consecutive_failures;
        this.standardsFailure = { error: standards.last_error ?? 'unknown error', failures, retryAt: Date.now() + standardsRetryMs(failures) };
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
      // Sync health says why nothing is polled when something saved cannot be used (a password
      // saved under another ENCRYPTION_KEY, an incomplete connection, an invalid mapping).
      const problem = configError(this.config);
      const snapshot = this.breaker.snapshot();
      await this.health.report({
        snapshot: problem ? { ...snapshot, lastError: problem } : snapshot,
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

    if (await this.loginStillRefused()) {
      await this.health.report({
        snapshot: this.healthSnapshot(),
        now: Date.now(),
        intervalMs,
        threshold: settings.breaker_failure_threshold,
        configured: true,
        force: true,
      });
      await this.delay(HEARTBEAT_SLICE_MS);
      // Read the connection again even without a restart command (a missed NOTIFY).
      this.reloadRequested = true;
      return;
    }

    const mapping = this.config?.mapping as MappingConfig;

    // A restart must not reset the backoff: when the hydrated breaker is still open, the first
    // poll waits until it closes (heartbeat and health reports keep going meanwhile).
    if (this.pollCount === 0 && this.breaker.isOpen(Date.now())) {
      const until = this.breaker.openUntil as number;
      this.log.info({ open_until: new Date(until).toISOString() }, 'circuit breaker still open after restart; waiting before the first poll');
      await this.idle(until, settings, mapping, intervalMs);
      return;
    }

    const now = Date.now();
    await this.source?.init();

    let outcome: PollOutcome;
    try {
      outcome = await (this.poller as Poller).pollOnce(mapping, settings, now);
    } catch (err) {
      outcome = { ok: false, requiredOk: false, loginRefused: null, rows: 0, touched: [], error: errorMessage(err), datasets: [], durationMs: Date.now() - now };
    }
    this.pollCount += 1;

    // Recompute whatever came in, even when another data source failed: the watermarks have
    // already moved past those rows. A failed recompute does not stop ingestion, but the numbers
    // on screen stop changing, so it goes into the sync health with the poll's own outcome.
    const notRecomputed =
      outcome.requiredOk || outcome.touched.length > 0 || this.staleHours.size > 0
        ? await this.recomputeTouched(outcome.touched, settings)
        : null;

    if (outcome.requiredOk) {
      // An optional data source failing (defects, operators, routes, standards) leaves the numbers
      // current: no backoff and no "Data delayed", but the status shows degraded with its error.
      if (notRecomputed) this.breaker.recordNotRecomputed(joinErrors(outcome.error, notRecomputed));
      else this.breaker.recordSuccess(Date.now(), outcome.error);
      if (outcome.ok) this.log.info({ rows: outcome.rows, ms: outcome.durationMs }, 'poll ok');
      else this.log.warn({ rows: outcome.rows, ms: outcome.durationMs, err: outcome.error }, 'poll ok except an optional data source');
    } else if (outcome.loginRefused) {
      this.breaker.recordLoginRefused(joinErrors(loginRefusedMessage(outcome.loginRefused), notRecomputed));
      this.refusedLogin = { connection: this.connectionFingerprint, savedAt: await connectionSavedAt(this.pool) };
      this.log.error({ err: outcome.loginRefused }, 'FactoryLogix refused the login; polling stops until Admin > Connection is saved again');
    } else {
      this.breaker.recordFailure(Date.now(), joinErrors(outcome.error ?? 'poll failed', notRecomputed), breakerOpts);
      this.log.warn({ err: outcome.error, failures: this.breaker.consecutiveFailures }, 'poll failed');
    }

    await this.health.report({
      snapshot: this.healthSnapshot(),
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

    // Refused: the next pass waits for the connection to be saved again, with no backfill either.
    if (this.refusedLogin) return;
    const delay = this.breaker.nextDelayMs(breakerOpts);
    await this.idle(Date.now() + delay, settings, mapping, intervalMs);
  }

  /**
   * Touched instants -> hour buckets (+ current and previous hour) -> recompute + NOTIFY, then the
   * `staleHours` of earlier polls, one contiguous range at a time: a range that keeps failing (a
   * row the database or the engine rejects) must not hold back the current hour or the others.
   * They wait while this poll's own hours fail, which more work would only make worse. Returns why
   * hour cells could not be recomputed, or null when every hour is up to date.
   */
  private async recomputeTouched(touched: number[], settings: Settings): Promise<string | null> {
    const tz = settings.plant_timezone;
    const hours = new Set<number>();
    const now = Date.now();
    const currentHour = hourStartUtc(now, tz);
    hours.add(currentHour);
    hours.add(currentHour - HOUR_MS);
    for (const instant of touched) {
      if (Number.isFinite(instant)) hours.add(hourStartUtc(instant, tz));
    }
    // As the plant time zone has those hours now: it may have been changed since they failed.
    const earlier = [...this.staleHours].map((hour) => hourStartUtc(hour, tz)).filter((hour) => !hours.has(hour));
    this.staleHours.clear();
    const errors = new Set<string>();
    const recompute = async (batch: number[]): Promise<void> => {
      try {
        await this.recomputer.recomputeHours(batch, settings, now);
      } catch (err) {
        for (const hour of batch) this.staleHours.add(hour);
        errors.add(errorMessage(err));
        this.log.error({ err: errorMessage(err), hours: batch.length }, 'hour cell recompute failed');
      }
    };
    await recompute([...hours]);
    if (errors.size > 0) for (const hour of earlier) this.staleHours.add(hour);
    else for (const range of mergeHourRanges(earlier)) await recompute(hoursInRange(range));
    if (errors.size === 0) return null;
    const count = this.staleHours.size === 1 ? '1 hour' : `${this.staleHours.size} hours`;
    return `could not recompute the hour cells of ${count} (${[...errors].join('; ')}); the collector tries again after every poll`;
  }

  /** True while the login FactoryLogix refused is still the saved one, not saved again since (see `refusedLogin`). */
  private async loginStillRefused(): Promise<boolean> {
    const refused = this.refusedLogin;
    if (!refused) return false;
    if (refused.connection === this.connectionFingerprint && refused.savedAt === (await connectionSavedAt(this.pool))) return true;
    this.refusedLogin = null;
    this.log.info('FactoryLogix connection saved again; polling again');
    return false;
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
      if (this.refusedLogin?.connection !== connectionFingerprint) await this.source.init(true);
    } else {
      this.source.setTimeoutSeconds(config.settings.odata_timeout_seconds);
    }
    this.source.setTimestampMode(config.settings.fl_timestamp_mode, config.settings.plant_timezone);

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
        await this.standardsRecomputed(settings, result);
        this.log.info(result, 'standards recomputed after backfill');
      });
    }
    await this.backfill.ensureScheduled(config.settings);

    if (this.nextStandardsAt === null) {
      try {
        const state = await this.health.load();
        this.nextStandardsAt = this.standardsDueAt(config.settings);
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
        // last_standards_recompute_at is the nightly job's cutoff: a run limited to one product must
        // not move it, or every other product's rows since the last full run are skipped tonight.
        // Nor does it end a failed nightly run: the other products' StdHr is still stale.
        if (!command.product_number) {
          await this.health.setLastStandardsRecompute(Date.now());
          await this.standardsRecomputed(settings, result);
        }
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

  /** Nightly standards recompute at `std_recompute_time` plant time (spec 7.1), or the retry of a failed one. */
  private async maybeRecomputeStandards(settings: Settings, mapping: MappingConfig): Promise<void> {
    const now = Date.now();
    if (this.nextStandardsAt === null || now < this.nextStandardsAt) return;
    let result: StandardsRunResult;
    try {
      const state = await this.health.load();
      result = await this.standards.run({
        settings,
        mapping,
        now,
        productNumber: null,
        since: state?.last_standards_recompute_at ?? null,
      });
      await this.health.setLastStandardsRecompute(now);
    } catch (err) {
      await this.standardsFailed(settings, err, Date.now() - now);
      return;
    }
    await this.standardsRecomputed(settings, result);
    this.nextStandardsAt = this.standardsDueAt(settings);
    // The standards are in: the next poll recomputes these two hours again if this fails.
    await this.recomputer.recomputeCurrentHours(settings, Date.now()).catch((err) => {
      this.log.error({ err: errorMessage(err) }, 'hour cell recompute failed');
    });
    this.log.info({ ...result, next: new Date(this.nextStandardsAt).toISOString() }, 'nightly standards recompute finished');
  }

  /** The standards of every product were recomputed: a failed nightly run is over, and so is its retry. */
  private async standardsRecomputed(settings: Settings, result: StandardsRunResult): Promise<void> {
    if (this.standardsFailure) {
      this.standardsFailure = null;
      this.nextStandardsAt = this.standardsDueAt(settings);
    }
    try {
      await recordSyncSuccess(this.pool, STANDARDS_SOURCE, { watermark: null, rows: result.computed, durationMs: result.durationMs });
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, 'could not record the standards recompute in sync_state');
    }
  }

  /**
   * The nightly standards recompute failed: StdHr stays as it was. It is tried again with a backoff
   * (`standardsRetryMs`), not after every poll: each attempt holds up the next poll for as long as
   * it runs.
   */
  private async standardsFailed(settings: Settings, err: unknown, durationMs: number): Promise<void> {
    const error = errorMessage(err);
    const failures = (this.standardsFailure?.failures ?? 0) + 1;
    this.standardsFailure = { error, failures, retryAt: Date.now() + standardsRetryMs(failures) };
    this.nextStandardsAt = this.standardsDueAt(settings);
    this.log.error({ err: error, failures, retry_at: new Date(this.nextStandardsAt).toISOString() }, 'standards recompute failed');
    try {
      await recordSyncFailure(this.pool, STANDARDS_SOURCE, error, durationMs);
    } catch (recordErr) {
      this.log.warn({ err: errorMessage(recordErr) }, 'could not record the failed standards recompute in sync_state');
    }
  }

  /** When the next standards recompute of every product runs: tonight's, or the retry of a failed one if sooner. */
  private standardsDueAt(settings: Settings): number {
    const tonight = nextLocalTime(settings.plant_timezone, settings.std_recompute_time, Date.now());
    return this.standardsFailure ? Math.min(tonight, this.standardsFailure.retryAt) : tonight;
  }

  /**
   * The breaker's state for the sync health, with a failed nightly standards recompute added to
   * `lastError` until a recompute of every product goes through: the data is current (no backoff,
   * not delayed), but the status stays degraded and says StdHr is going stale.
   */
  private healthSnapshot(): BreakerSnapshot {
    const snapshot = this.breaker.snapshot();
    const failure = this.standardsFailure;
    // Read back after a restart, `lastError` may still say so until the first poll replaces it.
    if (!failure || snapshot.lastError?.includes(STANDARDS_ERROR)) return snapshot;
    const retryAt = clockTime(this.nextStandardsAt ?? failure.retryAt, this.settings?.plant_timezone ?? this.env.plantTimezone);
    const standards = `${STANDARDS_ERROR} (${failure.error}); StdHr stays as last computed, the collector tries again at ${retryAt}`;
    return { ...snapshot, lastError: joinErrors(snapshot.lastError, standards) };
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
    /** FactoryLogix refused a chunk's login or account: no other chunk until the next poll tells whether it still does. */
    let refused = false;
    while (!this.stopping && Date.now() < until) {
      const now = Date.now();
      await this.health.report({
        snapshot: this.healthSnapshot(),
        now,
        intervalMs,
        threshold: settings.breaker_failure_threshold,
        configured: this.configured,
      });

      if (this.backfill) {
        await this.backfill.load();
        if (this.backfill.isActive()) {
          if (!refused && this.backfill.shouldRun(settings, now) && until - now > 5_000) {
            // One chunk per pass: a downloaded day, the standards recompute, or a re-colored day.
            const result = await this.backfill.tick(mapping, settings, Date.now()).catch((err) => {
              this.log.error({ err: errorMessage(err) }, 'backfill chunk failed');
              return null;
            });
            if (result?.error instanceof ODataError && result.error.isAuth) refused = true;
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
