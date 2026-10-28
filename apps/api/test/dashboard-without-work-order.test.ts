import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';
import { hourStartUtc } from '@fld/engine';
import type { Db } from '../src/db/pool.js';
import { buildDashboard } from '../src/services/dashboard.js';

const NOW = Date.parse('2026-10-28T15:20:00Z');
const THIS_HOUR = hourStartUtc(NOW, DEFAULT_SETTINGS.plant_timezone);

/** A database answering each statement with `rowsFor(sql)`; work_orders is always empty. */
function fakeDb(rowsFor: (sql: string) => unknown[]): Db {
  return {
    query: async (sql: string) => {
      const rows = sql.includes('FROM work_orders') ? [] : rowsFor(sql);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Db;
}

/** Job J-NEW: 12 units soldered this hour, 7 units through its last operation, no work order yet. */
const withActivity = fakeDb((sql) => {
  if (sql.includes('UNION ALL')) return [{ product_number: 'PB-2200', product_name: 'Controller Board' }];
  if (sql.includes('FROM hour_cells')) {
    return [
      {
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
      },
    ];
  }
  if (sql.includes('GROUP BY s.product_number, o.name')) return [{ product_number: 'PB-2200', operation: 'Solder' }];
  if (sql.includes('count(DISTINCT s.unit_id)')) return [{ job_number: 'J-NEW', units: 7 }];
  return [];
});

describe('buildDashboard for a job without a work order row', () => {
  it('shows the job from its activity: the product of its cells, units done, no released quantity', async () => {
    const dash = await buildDashboard(withActivity, 'J-NEW', {}, NOW, DEFAULT_SETTINGS);
    expect(dash.job).toEqual({
      job_number: 'J-NEW',
      product_number: 'PB-2200',
      product_name: 'Controller Board',
      qty_released: 0,
      qty_complete: 7,
      progress: 0,
    });
    expect(dash.rows.map((r) => [r.operation, r.operator_id, r.shift])).toEqual([['Solder', 'jrivera', 12]]);
  });

  it('is still an unknown job (404) when it has no activity either, so a TV keeps waiting for data', async () => {
    await expect(buildDashboard(fakeDb(() => []), 'J-TYPO', {}, NOW, DEFAULT_SETTINGS)).rejects.toMatchObject({
      statusCode: 404,
      message: 'unknown job J-TYPO',
    });
  });
});
