/**
 * Environment configuration for the collector service.
 * Everything else is configured in the database (settings table) via the admin UI.
 */

export interface Env {
  /** Postgres connection string. */
  databaseUrl: string;
  /** 32-byte AES key (hex) used to decrypt the FactoryLogix password. */
  encryptionKey: string;
  logLevel: string;
  /** Fallback plant time zone used only until settings are readable. */
  plantTimezone: string;
  nodeEnv: string;
  isProduction: boolean;
}

function buildDatabaseUrl(e: NodeJS.ProcessEnv): string {
  if (e.DATABASE_URL && e.DATABASE_URL.trim()) return e.DATABASE_URL.trim();
  const host = e.POSTGRES_HOST ?? e.PGHOST ?? 'db';
  const port = e.POSTGRES_PORT ?? e.PGPORT ?? '5432';
  const user = e.POSTGRES_USER ?? e.PGUSER ?? 'fld';
  const password = e.POSTGRES_PASSWORD ?? e.PGPASSWORD ?? '';
  const database = e.POSTGRES_DB ?? e.PGDATABASE ?? 'fld';
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const encryptionKey = (source.ENCRYPTION_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be set to 64 hex characters (32 bytes). Generate with: openssl rand -hex 32');
  }
  const nodeEnv = source.NODE_ENV ?? 'development';
  return {
    databaseUrl: buildDatabaseUrl(source),
    encryptionKey,
    logLevel: source.LOG_LEVEL ?? 'info',
    plantTimezone: source.PLANT_TIMEZONE ?? 'America/New_York',
    nodeEnv,
    isProduction: nodeEnv === 'production',
  };
}
