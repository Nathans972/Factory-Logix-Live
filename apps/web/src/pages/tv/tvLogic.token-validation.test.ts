/**
 * `POST /api/tv/register` accepts only a UUID (`tvRegisterSchema`: `z.string().uuid()`) and
 * `GET /api/tv/:token/state` answers 404/500 for anything else. `resolveDeviceToken` adopts and
 * persists (localStorage + a 10 year cookie) whatever string it finds, so one bad value bricks
 * the TV for good: later loads read the stored value back and register with it again, with or
 * without the `?token=` in the URL.
 *
 * Two ways to get a bad value on a real TV: an installer types a bookmark such as `/tv?token=4821`
 * (the pairing code instead of the UUID, spec 8.1), or the TV ran an earlier build on the
 * plain-HTTP address from INSTALL.md, where `crypto.randomUUID` does not exist and the TV generated
 * `tv-<random>`; fixing the generator does not heal a TV that already stored that value.
 */
import { describe, expect, it } from 'vitest';
import { resolveDeviceToken } from './tvLogic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRESH = '3f2b8c1e-5a47-4d6b-9c0e-7a1d2e3f4a5b';
const STORED = '0c9d6a52-1b7e-4f43-8a3d-5e6f7a8b9c0d';
const generate = () => FRESH;

describe('resolveDeviceToken only adopts tokens the API can register', () => {
  it('does not adopt a ?token= that is not a UUID', () => {
    const r = resolveDeviceToken({ search: '?token=4821', stored: null, isMock: false, generate });
    expect(r.token).toMatch(UUID);
  });

  it('falls back to a valid stored token when the bookmark token is not a UUID', () => {
    const r = resolveDeviceToken({ search: '?token=4821', stored: STORED, isMock: false, generate });
    expect(r.token).toBe(STORED);
  });

  it('replaces a stored token that is not a UUID (written by an earlier build on plain HTTP)', () => {
    const r = resolveDeviceToken({ search: '', stored: 'tv-0.k3j2h1g9x1f2a', isMock: false, generate });
    expect(r).toEqual({ token: FRESH, persist: true, source: 'generated' });
  });

  it('keeps a valid ?token= and a valid stored token as they are', () => {
    expect(resolveDeviceToken({ search: `?token=${STORED}`, stored: null, isMock: false, generate }).token).toBe(STORED);
    expect(resolveDeviceToken({ search: '', stored: STORED, isMock: false, generate }).token).toBe(STORED);
  });

  it('keeps the ?demo=N shortcut of the demo build, which never reaches the real API', () => {
    expect(resolveDeviceToken({ search: '?demo=1', stored: null, isMock: true, generate }).token).toBe('demo-1');
  });
});
