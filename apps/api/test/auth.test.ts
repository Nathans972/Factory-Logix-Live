import { describe, expect, it } from 'vitest';
import { ROLE_RANK, roleAtLeast, signSession, verifySession } from '../src/auth/session.js';
import { updateUser } from '../src/db/repo/users.js';

const SECRET = 'a-very-long-test-session-secret-value';

describe('session jwt', () => {
  it('round-trips the user id and role', async () => {
    const token = await signSession({ userId: 42, role: 'manager' }, SECRET);
    const payload = await verifySession(token, SECRET);
    expect(payload).toEqual({ userId: 42, role: 'manager' });
  });

  it('carries the session version it was signed with', async () => {
    const token = await signSession({ userId: 42, role: 'manager', sessionVersion: 3 }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({ userId: 42, role: 'manager', sessionVersion: 3 });
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signSession({ userId: 1, role: 'admin' }, SECRET);
    expect(await verifySession(token, 'different-secret')).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySession('not-a-jwt', SECRET)).toBeNull();
    expect(await verifySession('', SECRET)).toBeNull();
  });

  it('uses HS256', async () => {
    const token = await signSession({ userId: 7, role: 'viewer' }, SECRET);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    expect(header.alg).toBe('HS256');
  });
});

describe('what ends the sessions a user already has', () => {
  it('a password reset and deactivation do; a role change and reactivation do not', async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [], rowCount: 0 };
      },
    };
    await updateUser(db as never, 2, { password_hash: 'new-hash' });
    await updateUser(db as never, 2, { active: false }); // so reactivating later does not bring old cookies back
    await updateUser(db as never, 2, { role: 'viewer' });
    await updateUser(db as never, 2, { active: true });
    const bumps = statements.map((sql) => sql.includes('session_version = session_version + 1'));
    expect(bumps).toEqual([true, true, false, false]);
  });
});

describe('role ordering', () => {
  it('is viewer < manager < admin', () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.manager);
    expect(ROLE_RANK.manager).toBeLessThan(ROLE_RANK.admin);
  });

  it('allows equal or higher roles only', () => {
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'manager')).toBe(false);
    expect(roleAtLeast('viewer', 'admin')).toBe(false);
    expect(roleAtLeast('manager', 'viewer')).toBe(true);
    expect(roleAtLeast('manager', 'manager')).toBe(true);
    expect(roleAtLeast('manager', 'admin')).toBe(false);
    expect(roleAtLeast('admin', 'viewer')).toBe(true);
    expect(roleAtLeast('admin', 'manager')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
  });

  it('treats a missing role as unauthorized', () => {
    expect(roleAtLeast(null, 'viewer')).toBe(false);
    expect(roleAtLeast(undefined, 'viewer')).toBe(false);
  });
});
