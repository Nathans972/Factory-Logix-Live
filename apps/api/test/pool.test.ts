import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';

describe('createPool', () => {
  it('listens for idle-client errors so a database restart does not crash the api', async () => {
    const warnings: string[] = [];
    const pool = createPool({ databaseUrl: 'postgres://localhost:1/none' }, { warn: (_obj, msg) => warnings.push(msg) });
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', new Error('terminating connection due to administrator command'), {} as never);
    expect(warnings).toEqual(['idle database connection lost']);
    await pool.end();
  });
});
