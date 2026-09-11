import { describe, expect, it } from 'vitest';
import { ROLE_RANK, roleAtLeast, signSession, verifySession } from '../src/auth/session.js';

const SECRET = 'a-very-long-test-session-secret-value';

describe('session jwt', () => {
  it('round-trips the user id and role', async () => {
    const token = await signSession({ userId: 42, role: 'manager' }, SECRET);
    const payload = await verifySession(token, SECRET);
    expect(payload).toEqual({ userId: 42, role: 'manager' });
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
