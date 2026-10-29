import { describe, expect, it } from 'vitest';
import { EnvError, buildDatabaseUrl, loadEnv } from '../src/env.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** Exactly the 32-character minimum. */
const SECRET = 'fedcba9876543210fedcba9876543210';

const base = {
  DATABASE_URL: 'postgres://fld:test@localhost:5432/fld',
  SESSION_SECRET: SECRET,
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
    expect(env.trustedProxies).toEqual([]);
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

  it('refuses the public .env.example placeholders and a short session secret', () => {
    expect(loadEnv({ ...base }).sessionSecret).toBe(SECRET);
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'change-me-64-random-characters' })).toThrow(/still the placeholder/);
    expect(() => loadEnv({ ...base, SESSION_SECRET: SECRET.slice(1) })).toThrow(/at least 32 characters/);
    for (const key of ['0'.repeat(64), 'f'.repeat(64), 'aA'.repeat(32)]) {
      expect(() => loadEnv({ ...base, ENCRYPTION_KEY: key }), key).toThrow(/ENCRYPTION_KEY is a placeholder/);
    }
  });

  it('reads TRUSTED_PROXIES as a list of addresses and ranges', () => {
    expect(loadEnv({ ...base, TRUSTED_PROXIES: ' 10.1.2.3, 192.168.50.0/24 ,fd00::/8,' }).trustedProxies).toEqual([
      '10.1.2.3',
      '192.168.50.0/24',
      'fd00::/8',
    ]);
    expect(loadEnv({ ...base, TRUSTED_PROXIES: '' }).trustedProxies).toEqual([]);
    for (const bad of ['proxy.example.com', '10.1.2.3/33', '10.1.2.3/', '10.1.2.3/8/1', 'fd00::/129', '*']) {
      expect(() => loadEnv({ ...base, TRUSTED_PROXIES: `10.1.2.3,${bad}` }), bad).toThrow(/TRUSTED_PROXIES/);
    }
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
