/**
 * Environment loading. Fails fast with one clear message listing everything that is missing.
 */

export interface AppEnv {
  nodeEnv: string;
  databaseUrl: string;
  sessionSecret: string;
  /** 64 hex characters = 32 bytes (AES-256-GCM key). */
  encryptionKeyHex: string;
  port: number;
  host: string;
  /** Seed value used only on first start when the settings row is missing. */
  plantTimezone: string | null;
  logLevel: string;
  migrationsDir: string | null;
  appVersion: string;
}

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

function str(src: NodeJS.ProcessEnv, key: string): string | null {
  const v = src[key];
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}

export function buildDatabaseUrl(src: NodeJS.ProcessEnv): string | null {
  const direct = str(src, 'DATABASE_URL');
  if (direct) return direct;
  const host = str(src, 'POSTGRES_HOST');
  const db = str(src, 'POSTGRES_DB');
  const user = str(src, 'POSTGRES_USER');
  if (!host || !db || !user) return null;
  const password = src.POSTGRES_PASSWORD ?? '';
  const port = str(src, 'POSTGRES_PORT') ?? '5432';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

export function loadEnv(src: NodeJS.ProcessEnv = process.env): AppEnv {
  const problems: string[] = [];

  const databaseUrl = buildDatabaseUrl(src);
  if (!databaseUrl) {
    problems.push(
      'DATABASE_URL is required (or POSTGRES_HOST + POSTGRES_DB + POSTGRES_USER [+ POSTGRES_PASSWORD, POSTGRES_PORT])',
    );
  }

  const sessionSecret = str(src, 'SESSION_SECRET');
  if (!sessionSecret) {
    problems.push('SESSION_SECRET is required (any long random string; used to sign login cookies)');
  }

  const encryptionKeyHex = str(src, 'ENCRYPTION_KEY');
  if (!encryptionKeyHex) {
    problems.push('ENCRYPTION_KEY is required (32 bytes hex-encoded: `openssl rand -hex 32`)');
  } else if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
    problems.push('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }

  const portRaw = str(src, 'PORT');
  const port = portRaw ? Number(portRaw) : 3001;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) problems.push(`PORT is not a valid port number: ${portRaw}`);

  const plantTimezone = str(src, 'PLANT_TIMEZONE');
  if (plantTimezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: plantTimezone });
    } catch {
      problems.push(`PLANT_TIMEZONE is not a valid IANA time zone: ${plantTimezone}`);
    }
  }

  if (problems.length > 0) throw new EnvError(problems);

  return {
    nodeEnv: str(src, 'NODE_ENV') ?? 'development',
    databaseUrl: databaseUrl as string,
    sessionSecret: sessionSecret as string,
    encryptionKeyHex: (encryptionKeyHex as string).toLowerCase(),
    port,
    host: str(src, 'HOST') ?? '0.0.0.0',
    plantTimezone,
    logLevel: str(src, 'LOG_LEVEL') ?? 'info',
    migrationsDir: str(src, 'MIGRATIONS_DIR'),
    appVersion: str(src, 'APP_VERSION') ?? '',
  };
}
