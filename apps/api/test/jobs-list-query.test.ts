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

/** The one statement listJobsWithActivity sends for `opts`. */
async function statementFor(opts: Parameters<typeof listJobsWithActivity>[1]): Promise<string> {
  const statements: string[] = [];
  const db = {
    query: async (text: string) => {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
  await listJobsWithActivity(db as never, opts);
  expect(statements).toHaveLength(1);
  return statements[0]!;
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

  it('still counts a step that started before the 30 days and was completed in them', async () => {
    // Its job's last activity is that completion, so the job is active although no step of it
    // started in the window.
    const sql = await statementFor({ q: null, active: true });
    expect(sql).toMatch(/s\.start_ts < now\(\) - interval '30 days' AND s\.complete_ts >= now\(\) - interval '30 days'/);
  });

  it('reads only the steps of the jobs a search matches (the Job page asks for its job on every data update)', async () => {
    const sql = await statementFor({ q: 'J-1001', active: false });
    expect(enclosingGroupAfter(sql, 'FROM unit_steps')).toMatch(
      /\bWHERE s\.job_number IN \(SELECT w\.job_number FROM work_orders w WHERE \(w\.job_number ILIKE \$1\b/,
    );
  });
});
