import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';
import { hourStartUtc } from '@fld/engine';
import type { Db } from '../src/db/pool.js';
import { buildFloor } from '../src/services/floor.js';
import { buildJobDetailForJob } from '../src/services/job-detail.js';

const NOW = Date.parse('2026-10-28T15:20:00Z');
const THIS_HOUR = hourStartUtc(NOW, DEFAULT_SETTINGS.plant_timezone);

/**
 * A database in which job J-NEW has hour cells (its unit steps were ingested and computed) but no
 * work_orders row: the work order has not been pulled yet, or is older than the backfill window.
 * Every table that is not mentioned is empty.
 */
function dbWithoutWorkOrder(): Db {
  const cell = {
    hour_start_utc: new Date(THIS_HOUR),
    job_number: 'J-NEW',
    product_number: 'PB-2200',
    operation: 'Solder',
    operator_id: 'jrivera',
    units: 12,
    work_minutes: 50,
    window_minutes: 60,
    break_minutes: 0,
    charged_minutes: 50,
    eligible: true,
    provisional: true,
    std_hr: null,
    target_units: 0,
    pace: null,
    color: 'neutral',
  };
  return {
    query: async (sql: string) => (sql.includes('FROM hour_cells') ? { rows: [cell], rowCount: 1 } : { rows: [], rowCount: 0 }),
  } as unknown as Db;
}

describe('jobs that have activity but no work order row yet', () => {
  it('shows up on the floor overview with a job number the portal links to /jobs/<job>', async () => {
    const floor = await buildFloor(dbWithoutWorkOrder(), false, NOW);
    expect(floor.rows.map((r) => r.job_number)).toEqual(['J-NEW']);
  });

  it('can be opened from that link (GET /api/portal/jobs/:job) instead of failing with 404 "unknown job"', async () => {
    await expect(buildJobDetailForJob(dbWithoutWorkOrder(), 'J-NEW', NOW)).resolves.toBeDefined();
  });
});
