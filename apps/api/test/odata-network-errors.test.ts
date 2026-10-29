import { describe, expect, it } from 'vitest';
import { fetchMetadata } from '../src/odata.js';

// "Test connection" in the setup wizard and on Admin > Connection shows `error` as returned here.
// Port 1 on localhost refuses connections at once, like a stopped Report Scheduler Service.
describe('Test connection when FactoryLogix cannot be reached', () => {
  it('names the reason (the real cause is in err.cause; Node reports only "fetch failed")', async () => {
    const result = await fetchMetadata({ base_url: 'http://127.0.0.1:1/odata', username: 'u', password: 'p' }, 5000);
    expect(result.metadata).toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED|refused/i);
  });
});
