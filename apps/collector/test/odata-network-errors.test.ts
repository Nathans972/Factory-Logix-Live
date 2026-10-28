import { describe, expect, it } from 'vitest';
import { ODataClient } from '../src/odata/client.js';

// Port 1 on localhost refuses connections at once, like a stopped Report Scheduler Service.
// Node's fetch (undici) reports every network failure as `TypeError: fetch failed` and puts the real
// reason (ECONNREFUSED, ENOTFOUND, a certificate error, a connect timeout) in `err.cause`.
describe('ODataClient network failures', () => {
  it('names the reason in the error, because that message is what Admin > Sync and /api/health/sync show', async () => {
    const client = new ODataClient({ baseUrl: 'http://127.0.0.1:1/odata', username: 'u', password: 'p', timeoutSeconds: 5 });
    const err = (await client.fetchMetadata().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    // Today: "OData request failed: fetch failed" for a wrong host, a stopped service, a firewall drop
    // and a certificate problem alike.
    expect(err.message).toMatch(/ECONNREFUSED|refused/i);
  });
});
