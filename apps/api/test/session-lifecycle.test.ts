import { pino } from 'pino';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { hashPassword } from '../src/auth/password.js';
import { buildServer } from '../src/server.js';

/**
 * How long a session cookie keeps working. The `onRequest` hook re-reads the user on every request, so
 * deactivation and a role change take effect at once (the two control tests below). The JWT itself is
 * valid for 30 days and nothing on the server records that it was logged out or that the password
 * changed, so those two do not end a session that someone else already holds.
 */
const SECRET = 'k7Qm2vXz9LrT4pWc8NfYb3HsJd6AaEu5GxV1oRiBt0Zy';

interface Row {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
  [column: string]: unknown;
}

/** A users table that answers the handful of statements auth and admin/users issue, whatever columns they select. */
function fakeUsersDb(rows: Row[]) {
  const evalRhs = (rhs: string, row: Row, params: unknown[]): unknown => {
    const t = rhs.trim();
    const param = /^\$(\d+)(::\w+)?$/.exec(t);
    if (param) return params[Number(param[1]) - 1];
    if (/^now\(\)$/i.test(t)) return new Date();
    if (/^null$/i.test(t)) return null;
    const inc = /^(\w+)\s*\+\s*1$/.exec(t);
    if (inc) return Number(row[inc[1]] ?? 0) + 1;
    return row[t];
  };
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM users WHERE id = \$1$/i.test(sql)) {
      return { rows: rows.filter((r) => r.id === params[0]).map((r) => ({ ...r })), rowCount: 0 };
    }
    if (/FROM users WHERE lower\(username\) = lower\(\$1\)/i.test(sql)) {
      const want = String(params[0]).toLowerCase();
      return { rows: rows.filter((r) => r.username.toLowerCase() === want).map((r) => ({ ...r })), rowCount: 0 };
    }
    const upd = /^UPDATE users SET (.+?) WHERE id = \$(\d+)(?: RETURNING .*)?$/i.exec(sql);
    if (upd) {
      const row = rows.find((r) => r.id === params[Number(upd[2]) - 1]);
      if (!row) return { rows: [], rowCount: 0 };
      for (const assignment of upd[1].split(',')) {
        const [col, ...rhs] = assignment.split('=');
        row[col.trim()] = evalRhs(rhs.join('='), row, params);
      }
      return { rows: /RETURNING/i.test(sql) ? [{ ...row }] : [], rowCount: 1 };
    }
    if (/count\(\*\)::int AS n FROM users WHERE active AND role = 'admin'/i.test(sql)) {
      return { rows: [{ n: rows.filter((r) => r.active && r.role === 'admin').length }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query };
}

let app: FastifyInstance | null = null;
let rows: Row[] = [];
let rootHash = '';
let aliceHash = '';

beforeAll(async () => {
  rootHash = await hashPassword('root-password-1');
  aliceHash = await hashPassword('alice-password-1');
});

async function boot(): Promise<FastifyInstance> {
  const now = new Date('2026-01-01T00:00:00Z');
  rows = [
    { id: 1, username: 'root', password_hash: rootHash, role: 'admin', active: true, created_at: now, last_login_at: null },
    { id: 2, username: 'alice', password_hash: aliceHash, role: 'manager', active: true, created_at: now, last_login_at: null },
  ];
  const db = fakeUsersDb(rows);
  app = await buildServer({
    env: { sessionSecret: SECRET },
    db,
    pool: db,
    log: pino({ level: 'silent' }),
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext);
  return app;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(server: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password }),
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'fld_session');
  expect(cookie?.value).toBeTruthy();
  return cookie!.value;
}

async function whoAmI(server: FastifyInstance, token: string): Promise<string | null> {
  const res = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `fld_session=${token}` } });
  return (res.json() as { user: { username: string } | null }).user?.username ?? null;
}

async function patchUser(server: FastifyInstance, adminToken: string, id: number, body: object): Promise<number> {
  const res = await server.inject({
    method: 'PATCH',
    url: `/api/admin/users/${id}`,
    headers: { 'content-type': 'application/json', cookie: `fld_session=${adminToken}` },
    payload: JSON.stringify(body),
  });
  return res.statusCode;
}

describe('what ends an existing session', () => {
  it('control: deactivating the user ends it at once', async () => {
    const server = await boot();
    const alice = await login(server, 'alice', 'alice-password-1');
    const root = await login(server, 'root', 'root-password-1');
    expect(await whoAmI(server, alice)).toBe('alice');
    expect(await patchUser(server, root, 2, { active: false })).toBe(200);
    expect(await whoAmI(server, alice)).toBeNull();
  });

  it('control: a role change applies at once', async () => {
    const server = await boot();
    const alice = await login(server, 'alice', 'alice-password-1');
    const root = await login(server, 'root', 'root-password-1');
    expect(await patchUser(server, root, 2, { role: 'viewer' })).toBe(200);
    const res = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `fld_session=${alice}` } });
    expect((res.json() as { user: { role: string } }).user.role).toBe('viewer');
  });

  it('an admin resetting the password ends the sessions the user already has', async () => {
    const server = await boot();
    const stolen = await login(server, 'alice', 'alice-password-1');
    const root = await login(server, 'root', 'root-password-1');
    expect(await whoAmI(server, stolen)).toBe('alice');

    await sleep(1100); // the reset happens later than the sign-in, as it would in practice
    expect(await patchUser(server, root, 2, { password: 'alice-new-password-2' })).toBe(200);

    expect(await whoAmI(server, stolen)).toBeNull();

    await sleep(1100);
    const fresh = await login(server, 'alice', 'alice-new-password-2');
    expect(await whoAmI(server, fresh)).toBe('alice');
  });

  it('logging out ends the session on the server, not only in the browser', async () => {
    const server = await boot();
    const token = await login(server, 'alice', 'alice-password-1');
    const out = await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `fld_session=${token}` } });
    expect(out.statusCode).toBe(200);
    // Someone who copied the cookie before the user logged out replays it.
    expect(await whoAmI(server, token)).toBeNull();
  });
});
