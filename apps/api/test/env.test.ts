import { describe, expect, it } from 'vitest';
import { EnvError, buildDatabaseUrl, loadEnv } from '../src/env.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const base = {
  DATABASE_URL: 'postgres://fld:test@localhost:5432/fld',
  SESSION_SECRET: 'secret',
  ENCRYPTION_KEY: KEY,
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('loads defaults', () => {
    const env = loadEnv({ ...base });
    expect(env.port).toBe(3001);
    expect(env.host).toBe('0.0.0.0');
    expect(env.logLevel).toBe('info');
    expect(env.plantTimezone).toBeNull();
    expect(env.migrationsDir).toBeNull();
  });

  it('reports every missing required variable at once', () => {
    try {
      loadEnv({});
      throw new Error('expected loadEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const problems = (err as EnvError).problems.join('\n');
      expect(problems).toMatch(/DATABASE_URL/);
      expect(problems).toMatch(/SESSION_SECRET/);
      expect(problems).toMatch(/ENCRYPTION_KEY/);
    }
  });

  it('rejects a bad encryption key or time zone', () => {
    expect(() => loadEnv({ ...base, ENCRYPTION_KEY: 'too-short' })).toThrow(/64 hex/);
    expect(() => loadEnv({ ...base, PLANT_TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA/);
    expect(loadEnv({ ...base, PLANT_TIMEZONE: 'America/New_York' }).plantTimezone).toBe('America/New_York');
  });

  it('builds a database url from POSTGRES_* parts', () => {
    const url = buildDatabaseUrl({
      POSTGRES_HOST: 'db',
      POSTGRES_DB: 'fld',
      POSTGRES_USER: 'fld',
      POSTGRES_PASSWORD: 'p@ss:word',
    });
    expect(url).toBe('postgres://fld:p%40ss%3Aword@db:5432/fld');
  });

  it('prefers DATABASE_URL when both are present', () => {
    expect(buildDatabaseUrl({ ...base, POSTGRES_HOST: 'db', POSTGRES_DB: 'x', POSTGRES_USER: 'y' })).toBe(
      base.DATABASE_URL,
    );
  });
});
