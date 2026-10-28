import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';

describe('createPool statement timeout', () => {
  it('puts an upper bound on how long one query can hold a pooled connection', async () => {
    const pool = createPool({ databaseUrl: 'postgres://localhost:1/none' }, { warn: () => undefined });
    const options = pool.options as unknown as Record<string, unknown>;

    // Any of the usual ways to bound a query counts: node-pg's statement_timeout / query_timeout,
    // a `-c statement_timeout=...` startup option, or a SET on every new connection.
    const bounded =
      Number(options.statement_timeout) > 0 ||
      Number(options.query_timeout) > 0 ||
      /statement_timeout/.test(String(options.options ?? '')) ||
      pool.listenerCount('connect') > 0;

    await pool.end();
    expect(bounded).toBe(true);
  });
});
