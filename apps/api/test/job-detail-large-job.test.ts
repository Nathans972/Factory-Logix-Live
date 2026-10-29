import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type HourCell, type ShiftDef } from '@fld/shared';

const HOUR_MS = 3_600_000;
const NOW = Date.parse('2026-10-28T12:00:00Z');

let cells: HourCell[] = [];

vi.mock('../src/services/dashboard.js', () => ({ buildDashboard: async () => ({}) }));
vi.mock('../src/db/repo/settings.js', () => ({ getSettings: async () => DEFAULT_SETTINGS }));
vi.mock('../src/db/repo/cells.js', () => ({ getCellsForJob: async () => cells }));
vi.mock('../src/db/repo/displays.js', () => ({ listDisplayRowsForJob: async () => [] }));
vi.mock('../src/db/repo/operators.js', () => ({ getOperatorNames: async () => ({}) }));
vi.mock('../src/db/repo/schedule.js', () => ({
  listShifts: async (): Promise<ShiftDef[]> => {
    const every = { days_of_week: [0, 1, 2, 3, 4, 5, 6], effective_from: '2020-01-01', effective_to: null };
    return [
      { id: 1, name: 'Day', start_local: '06:00', end_local: '14:00', ...every },
      { id: 2, name: 'Evening', start_local: '14:00', end_local: '22:00', ...every },
      { id: 3, name: 'Night', start_local: '22:00', end_local: '06:00', ...every },
    ];
  },
}));

const { buildJobDetailForJob } = await import('../src/services/job-detail.js');

/** `perHour` active operator/operation pairs for as many consecutive hours as `count` needs. */
function hourCells(count: number, perHour: number): HourCell[] {
  const first = NOW - Math.ceil(count / perHour) * HOUR_MS;
  const out: HourCell[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      hour_start_utc: first + Math.floor(i / perHour) * HOUR_MS,
      job_number: 'J-BIG',
      product_number: 'P-1',
      operation: `Op${i % 10}`,
      operator_id: `E${i % perHour}`,
      units: 5,
      work_minutes: 50,
      window_minutes: 60,
      break_minutes: 0,
      charged_minutes: 60,
      eligible: true,
      provisional: false,
      std_hr: 10,
      target_units: 10,
      pace: 0.5,
      color: 'green',
    });
  }
  return out;
}

const db = { query: async () => ({ rows: [], rowCount: 0 }) };

describe('job detail for a job with a long production history', () => {
  it('still builds when the job has 130,000 hour cells (100 operator/operation pairs for 1,300 hours)', async () => {
    cells = hourCells(130_000, 100);
    const detail = await buildJobDetailForJob(db, 'J-BIG', NOW);
    expect(detail.shift_history.length).toBeGreaterThan(0);
  });
});
