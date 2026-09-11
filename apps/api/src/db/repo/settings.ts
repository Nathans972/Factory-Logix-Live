import { DEFAULT_SETTINGS, SETTINGS_KEYS, type Settings } from '@fld/shared';
import type { Db } from '../pool.js';

type SettingRow = { key: string; value: unknown };

let cache: { at: number; settings: Settings } | null = null;
const CACHE_TTL_MS = 3_000;

export function invalidateSettingsCache(): void {
  cache = null;
}

/** DEFAULT_SETTINGS merged with the rows present in `settings`. */
export async function getSettings(db: Db, opts: { fresh?: boolean } = {}): Promise<Settings> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;
  const { rows } = await db.query<SettingRow>('SELECT key, value FROM settings');
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of SETTINGS_KEYS) {
    if (byKey.has(key)) {
      const value = byKey.get(key);
      if (value !== null && value !== undefined) merged[key] = value;
    }
  }
  const settings = merged as unknown as Settings;
  cache = { at: Date.now(), settings };
  return settings;
}

export async function getSettingValue<T>(db: Db, key: string): Promise<T | null> {
  const { rows } = await db.query<SettingRow>('SELECT key, value FROM settings WHERE key = $1', [key]);
  if (rows.length === 0) return null;
  return (rows[0].value ?? null) as T | null;
}

export async function settingExists(db: Db, key: string): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM settings WHERE key = $1', [key]);
  return (rows[0]?.n ?? 0) > 0;
}

export async function setSettingValue(db: Db, key: string, value: unknown, updatedBy: string | null): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value ?? null), updatedBy],
  );
  invalidateSettingsCache();
}

/** Insert a settings row only when it does not exist yet (first-start seeding). */
export async function seedSettingValue(db: Db, key: string, value: unknown): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'env')
     ON CONFLICT (key) DO NOTHING`,
    [key, JSON.stringify(value ?? null)],
  );
  invalidateSettingsCache();
  return (res.rowCount ?? 0) > 0;
}

export async function applySettingsPatch(
  db: Db,
  patch: Partial<Settings>,
  updatedBy: string | null,
): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await setSettingValue(db, key, value, updatedBy);
  }
}

export async function getPlantTimezone(db: Db): Promise<string> {
  return (await getSettings(db)).plant_timezone;
}
