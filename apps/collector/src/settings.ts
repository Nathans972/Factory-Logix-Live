/**
 * Loads collector configuration out of the `settings` table:
 *   - engine/collector settings (one row per key, merged over DEFAULT_SETTINGS)
 *   - `mapping`        -> MappingConfig (spec 4.8), with `mapping_key_history` as `previous_keys`
 *   - `fl_connection`  -> { base_url, username, password_enc } (spec 10.4)
 */
import {
  DEFAULT_SETTINGS,
  MAPPING_KEY_HISTORY,
  SETTINGS_KEYS,
  URL_CREDENTIALS_MESSAGE,
  mappingConfigSchema,
  parseMappingKeyHistory,
  settingsSchema,
  urlHasCredentials,
  withPreviousKeys,
  type MappingConfig,
  type Settings,
  type SettingsKey,
} from '@fld/shared';
import { decryptSecret, isEncrypted } from './crypto.js';
import type { Logger } from './logger.js';
import { q, q1, toMs, type Queryable } from './db.js';

export interface FlCredentials {
  base_url: string;
  username: string;
  password: string;
}

export interface CollectorConfig {
  settings: Settings;
  mapping: MappingConfig | null;
  connection: FlCredentials | null;
  /** Raw `fl_connection` row existed but could not be used (bad password, missing fields). */
  connection_error: string | null;
  mapping_error: string | null;
}

interface SettingsRow {
  key: string;
  value: unknown;
}

export function mergeSettings(rows: { key: string; value: unknown }[], fallbackTimezone: string, log?: Logger): Settings {
  const raw: Record<string, unknown> = { ...DEFAULT_SETTINGS, plant_timezone: fallbackTimezone };
  const known = new Set<string>(SETTINGS_KEYS as string[]);
  for (const row of rows) {
    if (known.has(row.key)) raw[row.key] = row.value;
  }
  const parsed = settingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // One bad row must not take the whole configuration down: validate key by key.
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS, plant_timezone: fallbackTimezone };
  for (const key of SETTINGS_KEYS) {
    const candidate = raw[key];
    const shape = settingsSchema.shape[key as SettingsKey];
    const single = shape.safeParse(candidate);
    if (single.success) {
      out[key] = single.data;
    } else {
      log?.warn({ key, issue: single.error.issues[0]?.message }, 'invalid setting value; using default');
    }
  }
  return settingsSchema.parse(out) as Settings;
}

export async function loadConfig(db: Queryable, opts: { encryptionKey: string; fallbackTimezone: string; log?: Logger }): Promise<CollectorConfig> {
  const rows = await q<SettingsRow & Record<string, unknown>>(db, 'SELECT key, value FROM settings');
  const settings = mergeSettings(rows, opts.fallbackTimezone, opts.log);

  let mapping: MappingConfig | null = null;
  let mapping_error: string | null = null;
  const mappingRow = rows.find((r) => r.key === 'mapping');
  if (mappingRow && mappingRow.value) {
    const parsed = mappingConfigSchema.safeParse(mappingRow.value);
    if (parsed.success) {
      // The keys its datasets had before: the rows stored under them are still there.
      mapping = withPreviousKeys(parsed.data as MappingConfig, parseMappingKeyHistory(rows.find((r) => r.key === MAPPING_KEY_HISTORY)?.value));
    } else {
      mapping_error = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    }
  }

  let connection: FlCredentials | null = null;
  let connection_error: string | null = null;
  const connRow = rows.find((r) => r.key === 'fl_connection');
  if (connRow && connRow.value && typeof connRow.value === 'object') {
    const value = connRow.value as { base_url?: unknown; username?: unknown; password_enc?: unknown };
    const base_url = typeof value.base_url === 'string' ? value.base_url.trim().replace(/\/+$/, '') : '';
    const username = typeof value.username === 'string' ? value.username : '';
    const passwordEnc = typeof value.password_enc === 'string' ? value.password_enc : '';
    if (urlHasCredentials(base_url)) {
      // Saved by an earlier version: fetch would repeat the URL, password included, in every poll
      // error (sync_log, Sync health).
      connection_error = URL_CREDENTIALS_MESSAGE;
    } else if (!base_url || !username || !passwordEnc) {
      connection_error = 'the FactoryLogix connection is incomplete: Admin > Connection needs the server URL, user name and password';
    } else {
      try {
        const password = isEncrypted(passwordEnc) ? decryptSecret(passwordEnc, opts.encryptionKey) : passwordEnc;
        connection = { base_url, username, password };
      } catch (err) {
        connection_error = `could not decrypt the FactoryLogix password with this ENCRYPTION_KEY: enter the password again in Admin > Connection (${(err as Error).message})`;
      }
    }
  }

  return { settings, mapping, connection, connection_error, mapping_error };
}

/**
 * When Admin > Connection was last saved: every save moves it, even one that keeps the saved
 * password. Null when it never was.
 */
export async function connectionSavedAt(db: Queryable): Promise<number | null> {
  const row = await q1<{ updated_at: Date | null }>(db, `SELECT updated_at FROM settings WHERE key = 'fl_connection'`);
  return toMs(row?.updated_at ?? null);
}

/** For Sync health while the collector waits for a login FactoryLogix refused to be saved again. */
export function loginRefusedMessage(error: string): string {
  return (
    `FactoryLogix refused the saved login (${error}). Polling has stopped so that retries cannot lock the account: ` +
    'check the user name and password in Admin > Connection, and the account in FactoryLogix (password changed, locked, ' +
    'disabled, or no rights to the OData service), then save Admin > Connection again to resume polling'
  );
}
