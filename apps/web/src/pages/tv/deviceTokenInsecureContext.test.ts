import { afterEach, describe, expect, it, vi } from 'vitest';
import { tvRegisterSchema } from '@fld/shared';
import { getDeviceToken } from './tvLogic';

/**
 * docs/INSTALL.md step 9 has people open `http://<host>:8080/tv` on each TV. That page is not a secure
 * context (it is neither https nor localhost), and browsers only define `crypto.randomUUID` in secure
 * contexts, so `randomToken()` falls back to `tv-<random><time>`. The API takes only UUIDs:
 * `POST /api/tv/register` validates `tvRegisterSchema` (`device_token: z.string().uuid()`) and
 * `GET /api/tv/:token/state` answers 404 unless the token matches `[0-9a-fA-F-]{36}`. The TV's register
 * call fails with 400, its follow-up state call with 404, and it stays "offline" without ever showing a
 * pairing code.
 */
describe('the device token a TV generates on a plain-HTTP page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is accepted by POST /api/tv/register when crypto.randomUUID exists (https or localhost)', () => {
    const token = getDeviceToken(false);
    expect(tvRegisterSchema.safeParse({ device_token: token }).success).toBe(true);
  });

  it('is still accepted by POST /api/tv/register when crypto.randomUUID is not defined (http://<host>:8080)', () => {
    const real = globalThis.crypto;
    // An insecure context still has getRandomValues, but not randomUUID.
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(a: T): T => real.getRandomValues(a) });
    expect(typeof (globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBe('undefined');

    const token = getDeviceToken(false);

    expect(tvRegisterSchema.safeParse({ device_token: token }).success).toBe(true);
    expect(token).toMatch(/^[0-9a-fA-F-]{36}$/);
  });
});
