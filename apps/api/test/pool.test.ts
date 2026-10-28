import { describe, expect, it } from 'vitest';
import { createPool, waitForDb } from '../src/db/pool.js';

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

describe('waitForDb', () => {
  it('logs why the database cannot be reached, and gives up with that reason', async () => {
    const warnings: [object, string][] = [];
    const reason = 'password authentication failed for user "fld"';
    const db = { query: () => Promise.reject(new Error(reason)) };
    await expect(waitForDb(db, { warn: (obj, msg) => warnings.push([obj, msg]) }, 2, 0)).rejects.toThrow(
      `database is not reachable: ${reason}`,
    );
    expect(warnings).toEqual([
      [{ err: reason }, 'database not reachable yet (attempt 1/2)'],
      [{ err: reason }, 'database not reachable yet (attempt 2/2)'],
    ]);
  });

  it('stops waiting once the database answers; a refused connection is named by its code', async () => {
    const warnings: [object, string][] = [];
    // pg's error for "localhost" when nothing listens on ::1 or 127.0.0.1: no message, only a code.
    const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    let calls = 0;
    const db = {
      query: async () => {
        calls += 1;
        if (calls === 1) throw refused;
        return { rows: [] } as never;
      },
    };
    await waitForDb(db, { warn: (obj, msg) => warnings.push([obj, msg]) }, 3, 0);
    expect(calls).toBe(2);
    expect(warnings).toEqual([[{ err: 'ECONNREFUSED' }, 'database not reachable yet (attempt 1/3)']]);
  });
});
