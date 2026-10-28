import { describe, expect, it } from 'vitest';
import { listJobsWithActivity } from '../src/db/repo/work-orders.js';

/** The text from just after `marker` up to the parenthesis that closes the group `marker` sits in. */
function enclosingGroupAfter(sql: string, marker: string): string {
  const start = sql.indexOf(marker);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start + marker.length; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return sql.slice(start + marker.length, i);
      depth -= 1;
    }
  }
  return sql.slice(start + marker.length);
}

describe('listJobsWithActivity (Jobs page, TV job picker)', () => {
  it('does not aggregate every row of unit_steps when only the active jobs are wanted', async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [], rowCount: 0 };
      },
    };

    // The default Jobs page request: active jobs, no search text. "Active" means activity in the last
    // 30 days, so the per-job max(start_ts)/max(complete_ts) never needs the rest of the history.
    await listJobsWithActivity(db as never, { q: null, active: true });

    expect(statements).toHaveLength(1);
    const unitStepsSubquery = enclosingGroupAfter(statements[0]!, 'FROM unit_steps');
    expect(unitStepsSubquery).toMatch(/\bWHERE\b/i);
  });
});
