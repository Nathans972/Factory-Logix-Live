import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { signSession } from '../src/auth/session.js';
import { loadEnv, type AppEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';

/**
 * `.env.example` ships SESSION_SECRET=change-me-64-random-characters and an all-zero ENCRYPTION_KEY, and
 * INSTALL.md step 5 starts with `cp .env.example .env`. Both values are public: with the secret anyone can
 * sign an admin session cookie, and with the key anyone holding a database dump can decrypt the stored
 * FactoryLogix password. An install that still has them must refuse to start.
 */
const example = Object.fromEntries(
  readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((line) => /^([A-Z_]+)=(.*)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2]]),
) as Record<string, string>;

const GOOD_SECRET = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const GOOD_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const base = {
  DATABASE_URL: 'postgres://fld:test@localhost:5432/fld',
  SESSION_SECRET: GOOD_SECRET,
  ENCRYPTION_KEY: GOOD_KEY,
} as NodeJS.ProcessEnv;

describe('loadEnv and the .env.example placeholders', () => {
  it('refuses to start with the SESSION_SECRET from .env.example', () => {
    expect(example.SESSION_SECRET).toBeTruthy();
    expect(() => loadEnv({ ...base, SESSION_SECRET: example.SESSION_SECRET })).toThrow(/SESSION_SECRET/);
  });

  it('refuses to start with the ENCRYPTION_KEY from .env.example', () => {
    expect(example.ENCRYPTION_KEY).toBeTruthy();
    expect(() => loadEnv({ ...base, ENCRYPTION_KEY: example.ENCRYPTION_KEY })).toThrow(/ENCRYPTION_KEY/);
  });

  it('starts with values generated as INSTALL.md says (`openssl rand -hex 32`)', () => {
    const env = loadEnv({ ...base });
    expect(env.encryptionKeyHex).toBe(GOOD_KEY);
    expect(env.sessionSecret).toBe(GOOD_SECRET);
  });
});

describe('a server started from the .env.example values', () => {
  it('does not log in a session token that anyone can forge with the public SESSION_SECRET', async () => {
    let env: AppEnv;
    try {
      env = loadEnv({
        ...base,
        SESSION_SECRET: example.SESSION_SECRET,
        ENCRYPTION_KEY: example.ENCRYPTION_KEY,
      } as NodeJS.ProcessEnv);
    } catch {
      return; // refusing to start is the fix
    }
    const adminRow = {
      id: 1,
      username: 'admin',
      role: 'admin',
      active: true,
      created_at: new Date('2026-01-01T00:00:00Z'),
      last_login_at: null,
    };
    const query = async (text: string) =>
      /FROM users WHERE id = \$1/i.test(text) ? { rows: [adminRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    const db = { query };
    const app = await buildServer({
      env,
      db,
      pool: db,
      log: pino({ level: 'silent' }),
      sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
      version: 'test',
    } as unknown as AppContext);
    try {
      // The attacker has only the repository: the secret from .env.example and the id of the first user.
      const forged = await signSession({ userId: 1, role: 'admin' }, example.SESSION_SECRET);
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: { cookie: `fld_session=${forged}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
