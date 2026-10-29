import { afterEach, describe, expect, it, vi } from 'vitest';
import { tvRegisterSchema } from '@fld/shared';
import { getDeviceToken } from './tvLogic';

afterEach(() => vi.unstubAllGlobals());

describe('device token on the documented plain-HTTP TV page', () => {
  it('is a UUID the API accepts when crypto.randomUUID is not available', () => {
    // Browsers only expose crypto.randomUUID() in secure contexts (HTTPS or localhost). The install
    // docs point TVs at http://<host>:8080/tv, which is not a secure context: there `crypto` has
    // getRandomValues() but no randomUUID().
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });

    const token = getDeviceToken(false);

    // POST /api/tv/register validates the body with tvRegisterSchema (device_token must be a UUID).
    const parsed = tvRegisterSchema.safeParse({ device_token: token });
    expect(parsed.success, `the TV would register with device_token "${token}"`).toBe(true);
  });
});
