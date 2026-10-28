import { describe, expect, it } from 'vitest';
import { getActiveJobNumbers } from '../src/db/repo/cells.js';

/** The text of `sql` with everything inside parentheses removed: the restrictions ANDed at the top level. */
function topLevel(sql: string): string {
  let depth = 0;
  let out = '';
  for (const ch of sql) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** The one statement getActiveJobNumbers sends for [fromUtc, toUtc). */
async function statementFor(fromUtc: number, toUtc: number): Promise<string> {
  const statements: string[] = [];
  const db = {
    query: async (text: string) => {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
  await getActiveJobNumbers(db as never, fromUtc, toUtc);
  expect(statements).toHaveLength(1);
  return statements[0]!;
}

describe('getActiveJobNumbers (shift view and Home page)', () => {
  it('has a restriction on start_ts outside the OR, so TimescaleDB can skip chunks outside the shift', async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [], rowCount: 0 };
      },
    };

    // A shift from last month: unit_steps is a hypertable on start_ts with 7-day chunks, and every
    // chunk older than 7 days is compressed. Only a top-level restriction on start_ts lets the planner
    // leave the other 50-odd chunks alone; an OR with a complete_ts range cannot be used for that, so
    // all of them are scanned and the compressed ones decompressed.
    await getActiveJobNumbers(db as never, Date.parse('2026-09-01T06:00:00Z'), Date.parse('2026-09-01T14:00:00Z'));

    expect(statements).toHaveLength(1);
    const where = statements[0]!.slice(statements[0]!.search(/\bWHERE\b/i));
    expect(topLevel(where)).toMatch(/\bstart_ts\s*(<=?|>=?)/);
  });

  it('reads the steps that started in the shift with start_ts bounded on both sides', async () => {
    // An upper bound alone would still read every chunk before the shift.
    const sql = await statementFor(Date.parse('2026-09-01T06:00:00Z'), Date.parse('2026-09-01T14:00:00Z'));
    expect(sql).toMatch(/\bWHERE start_ts >= \$1 AND start_ts < \$2\s+UNION\b/);
  });

  it('still finds a job whose only step started before the shift and completed in it', async () => {
    // A step running across the shift start, or one left open for days and closed during the
    // shift, makes its job active (spec 7.11) although it sits in an earlier chunk.
    const sql = await statementFor(Date.parse('2026-09-01T06:00:00Z'), Date.parse('2026-09-01T14:00:00Z'));
    expect(sql).toMatch(/\bWHERE start_ts < \$1 AND complete_ts >= \$1 AND complete_ts < \$2\b/);
  });
});
